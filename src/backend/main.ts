/**
 * The backend of Dictation, a headless app: its keys, its models and its
 * choices sit on its page in Settings. A press of the hotkey starts a dictation,
 * and when it ends the words go through the clean up into the program in front.
 * The HUD and the history at the tray icon hear it through events: `hud`,
 * `levels` and `history`.
 *
 * A key alone also fires `cancelled` when a second key goes down with it: the
 * person meant that combination, so the dictation is dropped.
 */
import type { AppContext, Backend, HotkeyFire, ProgramFire } from '@hearthscale/app';
import type { Entry, History, HudState, Levels } from '../shared/types.ts';
import { cleanUp, isTerminal } from './cleanup.ts';
import { Dictation, words as reason } from './listening.ts';

interface Settings {
  keyBehaviour: 'Hold or tap' | 'Hold' | 'Tap';
  insert: 'Automatic' | 'Type' | 'Paste';
  language: string;
  cleanUp: boolean;
  styles: boolean;
  words: string;
  history: boolean;
}

/** The languages of the settings, by the code a transcription model takes. */
const LANGUAGES: Record<string, string> = {
  English: 'en',
  German: 'de',
  French: 'fr',
  Spanish: 'es',
  Italian: 'it',
  Portuguese: 'pt',
  Dutch: 'nl',
  Polish: 'pl',
  Swedish: 'sv',
  Danish: 'da',
  Norwegian: 'no',
  Finnish: 'fi',
  Japanese: 'ja',
  Chinese: 'zh',
  Korean: 'ko',
};

/** A press shorter than this, in milliseconds, is a tap, which keeps the
 *  dictation going until the next press. */
const TAP_MS = 300;
/** The longest text that is typed; pasting is faster above it. */
const TYPED_MOST = 200;
/** How long a note stays on the HUD, in milliseconds. */
const NOTE_MS = 2400;
/** How long a key alone waits before the HUD shows, in milliseconds: long
 *  enough for the second key of Ctrl+C, so typing shows no flash. */
const KEY_ALONE_MS = 150;
/** How many dictations the history keeps. */
const HISTORY_MOST = 2000;

let ctx: AppContext;
let settings: Settings;
let program: string | null = null;
let keyAlone = false;
let hudId: string | null = null;
let hudOpening: Promise<void> | null = null;
let hud: HudState = { kind: 'gone' };
let noteTimer: ReturnType<typeof setTimeout> | null = null;

/** The dictation that hears now, and when its key went down. */
let current: { dictation: Dictation; pressedAt: number; heldKey: boolean } | null = null;
/** The text of the last dictation is on its way. */
let working = false;

function tell(state: HudState): void {
  hud = state;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = null;
  void ctx.events.emit({ name: 'hud', data: state, durable: false });
}

function note(words: string): void {
  tell({ kind: 'note', note: words });
  noteTimer = setTimeout(() => tell({ kind: 'gone' }), NOTE_MS);
}

/** Opens the HUD, which then stays and hides itself between dictations. */
function showHud(): Promise<void> {
  if (hudId) return Promise.resolve();
  hudOpening ??= ctx.overlay
    .view('hud', { anchor: { at: 'screen', place: 'bottom', margin: 16 }, clickThrough: true })
    .then((id) => {
      hudId = id;
    })
    .catch((e: unknown) => void ctx.log('warn', `the HUD did not open: ${reason(e)}`))
    .finally(() => {
      hudOpening = null;
    });
  return hudOpening;
}

const wordsToKnow = () =>
  settings.words
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);

/** Loads a cold chat model while the person speaks, so the clean up does not
 *  wait for it after they let go. */
async function warmUp(): Promise<void> {
  if (!settings.cleanUp || 'reason' in (await ctx.models.effective('chat'))) return;
  try {
    const answer = ctx.models.complete({
      messages: [{ role: 'user', content: 'ok' }],
      reasoning: 'none',
      sampling: { maxTokens: 1 },
    });
    for await (const delta of answer) void delta;
  } catch (e) {
    void ctx.log('info', `the chat model did not warm up: ${reason(e)}`);
  }
}

function start(): void {
  void showHud();
  void warmUp();
  const pressed = {
    pressedAt: Date.now(),
    heldKey: true,
    dictation: new Dictation(
      ctx,
      {
        language: LANGUAGES[settings.language] ?? null,
        words: wordsToKnow(),
      },
      {
        levels: (levels: Levels) =>
          void ctx.events.emit({ name: 'levels', data: levels, durable: false }),
        words: (said) => {
          if (hud.kind === 'speaking' || hud.kind === 'working') tell({ ...hud, words: said });
        },
        failed: (why) => void fail(why),
      },
    ),
  };
  current = pressed;
  if (keyAlone) {
    setTimeout(() => {
      if (current === pressed) tell({ kind: 'speaking', words: '' });
    }, KEY_ALONE_MS);
  } else tell({ kind: 'speaking', words: '' });
}

/** Ends a dictation that cannot go on, and says why. */
async function fail(why: string): Promise<void> {
  const dictation = current?.dictation;
  current = null;
  await dictation?.drop();
  void ctx.log('warn', why);
  note(why);
}

/** Puts the text where the person types. A typed line break is the Enter key,
 *  which sends a message in a chat program, so a text of several lines goes by
 *  paste, or as one line when the person asked for typing. */
async function insert(text: string): Promise<void> {
  const lines = text.includes('\n');
  if (settings.insert === 'Type') await ctx.desktop.type(text.replace(/\s*\n+\s*/g, ' '));
  else if (settings.insert === 'Paste' || lines || text.length > TYPED_MOST) {
    await ctx.desktop.paste(text);
  } else await ctx.desktop.type(text);
}

async function remember(text: string): Promise<void> {
  if (!settings.history) return;
  await ctx.db.exec('INSERT INTO entries (at, text, program) VALUES (?, ?, ?)', [
    Date.now(),
    text,
    program,
  ]);
  await ctx.db.exec(
    'DELETE FROM entries WHERE id NOT IN (SELECT id FROM entries ORDER BY id DESC LIMIT ?)',
    [HISTORY_MOST],
  );
  void ctx.events.emit({ name: 'history', data: {}, durable: false });
}

/** Ends the dictation that hears, and lands its text. */
async function finish(): Promise<void> {
  const dictation = current?.dictation;
  current = null;
  if (!dictation) return;
  working = true;
  tell({ kind: 'working', words: hud.kind === 'speaking' ? hud.words : '' });
  try {
    const heard = await dictation.end();
    if (!heard) {
      note('No speech heard.');
      return;
    }
    const chat = await ctx.models.effective('chat');
    const clean =
      settings.cleanUp && !('reason' in chat)
        ? await cleanUp(ctx, heard, { program, styles: settings.styles, words: wordsToKnow() })
        : heard;
    const text = isTerminal(program) ? clean.replace(/\s*\n+\s*/g, ' ') : clean;
    await remember(text);
    try {
      await insert(text);
      tell({ kind: 'gone' });
    } catch (e) {
      void ctx.log('warn', `the text was not inserted: ${reason(e)}`);
      note(settings.history ? 'The text is in History.' : 'The text could not be inserted.');
    }
  } catch (e) {
    void ctx.log('warn', reason(e));
    note(reason(e));
  } finally {
    working = false;
  }
}

/** A press of the keys, by what the person chose them to do. */
function pressed(): void {
  if (working) return;
  if (current) {
    void finish();
    return;
  }
  start();
}

function released(): void {
  if (!current) return;
  const held = Date.now() - current.pressedAt;
  current.heldKey = false;
  if (settings.keyBehaviour === 'Tap') return;
  if (settings.keyBehaviour === 'Hold or tap' && held < TAP_MS) return;
  void finish();
}

/** The person meant another key: the press of a dictation that goes on from
 *  an earlier tap changes nothing. */
function cancelled(): void {
  if (!current?.heldKey) return;
  const dictation = current.dictation;
  current = null;
  void dictation.drop();
  tell({ kind: 'gone' });
}

async function history(): Promise<History> {
  const rows = await ctx.db.query(
    'SELECT id, at, text, program FROM entries ORDER BY id DESC LIMIT ?',
    [HISTORY_MOST],
  );
  return { entries: rows as unknown as Entry[], keeps: settings.history };
}

/** Follows the hotkey's keys: a key alone holds the HUD back a moment. */
function keysChanged(hotkeys: { name: string; keys?: string }[]): void {
  const keys = hotkeys.find((key) => key.name === 'dictate')?.keys;
  keyAlone = !!keys && !keys.includes('+');
}

const backend: Backend = {
  async activate(context) {
    ctx = context;
    settings = (await ctx.settings.get()) as unknown as Settings;
    await ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        text TEXT NOT NULL,
        program TEXT
      );
    `);
    keysChanged(await ctx.triggers.hotkeys.list());
    ctx.settings.on('changed', (values) => {
      const before = settings.history;
      settings = values as unknown as Settings;
      if (before && !settings.history) void ctx.db.exec('DELETE FROM entries');
      void ctx.events.emit({ name: 'history', data: {}, durable: false });
    });
    ctx.triggers.on('dictate', (fired) => {
      const { phase } = fired as HotkeyFire;
      if (phase === 'pressed') pressed();
      else if (phase === 'released') released();
      else cancelled();
    });
    ctx.triggers.on('program', (fired) => {
      program = (fired as ProgramFire).program;
    });
    ctx.triggers.hotkeys.on('change', keysChanged);
    ctx.overlay.on('closed', () => {
      hudId = null;
    });
  },
  tools: {
    hud_state: () => ({ state: hud }),
    history: async () => ({ ...(await history()) }),
    async forget(input) {
      await ctx.db.exec('DELETE FROM entries WHERE id = ?', [(input as { id: number }).id]);
      return { forgotten: true };
    },
    async forget_all() {
      await ctx.db.exec('DELETE FROM entries');
      void ctx.events.emit({ name: 'history', data: {}, durable: false });
      return 'The history is empty.';
    },
  },
};

export default backend;
