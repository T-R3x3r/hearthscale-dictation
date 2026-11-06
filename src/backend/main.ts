/**
 * The backend of Dictation, a headless app: its keys, its models and its
 * choices sit on its page in Settings. A press of the hotkey starts a dictation,
 * and when it ends the words go through the clean up into the window in front
 * at that moment, and no other. The HUD and the history at the tray icon hear
 * it through events: `hud`, `levels` and `history`.
 *
 * A next dictation may start while the last one's text is on its way: the texts
 * land in order, each once the keys are up, for a program reads a held Ctrl plus
 * the text. A key alone also fires `cancelled` when a second key goes down with
 * it: the person meant that combination, so the dictation is dropped.
 */
import type { AppContext, Backend, HotkeyFire, ProgramFire } from '@hearthscale/app';
import type { Entry, History, HudState, Levels } from '../shared/types.ts';
import { cleanUp, isTerminal, type Around } from './cleanup.ts';
import { Dictation, words as reason } from './listening.ts';
import { startTest, stopTest, testSound } from './micTest.ts';
import { dictionaryOf, withAliases, withoutFillers, type Dictionary } from './words.ts';

interface Settings {
  keyBehaviour: 'Hold or tap' | 'Hold' | 'Tap';
  insert: 'Automatic' | 'Type' | 'Paste';
  language: string;
  translate: boolean;
  filterSilence: boolean;
  removeFillers: boolean;
  microphone: string;
  cleanUp: boolean;
  styles: boolean;
  aroundCursor: boolean;
  instructionsKind: 'Built-in' | 'Your own';
  instructions: string;
  correction: string;
  words: string[];
  history: boolean;
}

/** A dictation that hears now. */
interface Hearing {
  dictation: Dictation;
  pressedAt: number;
  /** Comes once this dictation no longer holds the keys. */
  letGo: Promise<void>;
  release: () => void;
  /** Why it stopped before the text came, in words. */
  failed: string | null;
}

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

let current: Hearing | null = null;
/** The texts on their way, one after the other. */
let landing: Promise<void> = Promise.resolve();
let landings = 0;
/** Ends the clean up that runs now, whose words then go in as they were heard. */
let skipCleanUp: (() => void) | null = null;
/** The hotkey that cancels holds its key. */
let armed = false;
/** The sound of the last dictation that failed, until the next one lands. */
let failedSound: Uint8Array[] | null = null;

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

const dictionary = (): Dictionary => dictionaryOf(settings.words);

/** Holds Escape while a dictation runs, and only then. */
function armEscape(): void {
  const wanted = current !== null || landings > 0;
  if (wanted === armed) return;
  armed = wanted;
  void ctx.triggers.hotkeys
    .arm('cancel', wanted)
    .catch((e: unknown) => void ctx.log('warn', `Escape was not held: ${reason(e)}`));
}

/** What the card of the transcription model states. */
async function speechFacts() {
  const effective = await ctx.models.effective('transcription');
  if (effective.card === null) return null;
  const { cards } = await ctx.models.list({ kind: 'transcription' });
  return cards.find((card) => card.id === effective.card)?.speech ?? null;
}

/** The language a dictation asks for: the person's where the model hears it, and
 *  else the only one or none, for the model to tell. A model that cannot tell
 *  takes English, or its first. */
async function languageNow(): Promise<string | null> {
  const facts = await speechFacts().catch(() => null);
  const known = facts?.languages ?? [];
  if (known.length === 1) return known[0]!;
  if (settings.language && (known.length === 0 || known.includes(settings.language))) {
    return settings.language;
  }
  if (facts?.detects === false) return known.includes('en') ? 'en' : (known[0] ?? null);
  return null;
}

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
  let release = () => {};
  const letGo = new Promise<void>((resolve) => (release = resolve));
  const hearing: Hearing = {
    pressedAt: Date.now(),
    letGo,
    release,
    failed: null,
    dictation: new Dictation(
      ctx,
      {
        language: languageNow(),
        dictionary: dictionary(),
        device: settings.microphone || null,
        translate: settings.translate,
        filterSilence: settings.filterSilence,
      },
      {
        levels: (levels: Levels) =>
          void ctx.events.emit({ name: 'levels', data: levels, durable: false }),
        words: (said, tentative) => {
          if (current && current !== hearing) return;
          if (hud.kind === 'speaking' || hud.kind === 'working') {
            tell({ ...hud, words: said, tentative });
          }
        },
        failed: (why) => fail(hearing, why),
        silent: () => {
          if (current === hearing) finish();
        },
      },
    ),
  };
  current = hearing;
  armEscape();
  const speaking = () => {
    void warmUp();
    tell({ kind: 'speaking', words: '' });
  };
  if (keyAlone) {
    setTimeout(() => {
      if (current === hearing) speaking();
    }, KEY_ALONE_MS);
  } else speaking();
}

/** Ends a dictation that cannot go on, and says why. */
function fail(hearing: Hearing, why: string): void {
  void ctx.log('warn', why);
  hearing.failed = why;
  keepFailed(hearing);
  void hearing.dictation.drop();
  if (current !== hearing) return;
  current = null;
  armEscape();
  hearing.release();
  note(why);
}

/** Keeps the sound of a dictation that failed, for History to hear it again. */
function keepFailed(hearing: Hearing): void {
  const sound = hearing.dictation.sound();
  if (sound.length === 0) return;
  failedSound = sound;
  void ctx.events.emit({ name: 'history', data: {}, durable: false });
}

/** Puts the text in the window `front`. A typed line break is the Enter key,
 *  which sends a message in a chat program, so a text of several lines goes by
 *  paste, or as one line when the person asked for typing. */
async function insert(text: string, front: string | null): Promise<void> {
  const held = front ? { front } : {};
  if (settings.insert === 'Type') {
    await ctx.desktop.type(text.replace(/\s*\n+\s*/g, ' '), held);
  } else if (settings.insert === 'Paste' || text.includes('\n') || text.length > TYPED_MOST) {
    await ctx.desktop.paste(text, held);
  } else await ctx.desktop.type(text, held);
}

async function remember(text: string): Promise<void> {
  if (!settings.history) return;
  try {
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
  } catch (e) {
    void ctx.log('warn', `the history kept nothing: ${reason(e)}`);
  }
}

/** Lands one dictation's text; answers what the HUD says of it, if anything. */
async function land(
  hearing: Hearing,
  front: string | null,
  around: Promise<Around | null>,
): Promise<string | null> {
  try {
    const heard = await written(await hearing.dictation.end());
    if (!heard) return hearing.failed ?? 'No speech heard.';
    const clean = await cleaned(heard, around);
    const text = isTerminal(program) ? clean.replace(/\s*\n+\s*/g, ' ') : clean;
    await remember(text);
    if (failedSound) {
      failedSound = null;
      void ctx.events.emit({ name: 'history', data: {}, durable: false });
    }
    await current?.letGo;
    try {
      await insert(text, front);
    } catch (e) {
      void ctx.log('warn', `the text was not inserted: ${reason(e)}`);
      return settings.history ? 'The text is in History.' : 'The text could not be inserted.';
    }
    return null;
  } catch (e) {
    void ctx.log('warn', reason(e));
    keepFailed(hearing);
    return reason(e);
  }
}

/** The heard words without their filler sounds, where the person wants them out. */
async function written(heard: string): Promise<string> {
  if (!settings.removeFillers || !heard) return heard;
  return withoutFillers(heard, await languageNow(), settings.correction);
}

/** The heard words after the chat model, where the person wants it and has one. */
async function cleaned(heard: string, around: Promise<Around | null>): Promise<string> {
  const chat = await ctx.models.effective('chat');
  if (!settings.cleanUp || chat.card === null) return heard;
  const skip = new AbortController();
  skipCleanUp = () => skip.abort();
  try {
    const { words, aliases } = dictionary();
    const clean = await cleanUp(ctx, heard, {
      program,
      styles: settings.styles,
      words,
      instructions: settings.instructionsKind === 'Your own' ? settings.instructions : null,
      correction: settings.correction,
      around: await around,
      skip: skip.signal,
    });
    return withAliases(clean, aliases);
  } finally {
    skipCleanUp = null;
  }
}

/** Hears the sound of the dictation that failed again; the text goes to History. */
async function hearAgain(): Promise<string> {
  const sound = failedSound;
  if (!sound) return 'No dictation waits to be heard again.';
  const { words, aliases } = dictionary();
  const stream = await ctx.models.listen({
    pauses: false,
    words,
    ...(Object.keys(aliases).length > 0 && { aliases }),
    translate: settings.translate,
  });
  const texts: string[] = [];
  const done = new Promise<void>((resolve, refuse) => {
    stream.on('segment', ({ text }) => texts.push(text));
    stream.on('error', ({ message }) => refuse(new Error(message)));
    stream.on('done', () => resolve());
  });
  for (const part of sound) await stream.write(part);
  await stream.end();
  await done;
  const text = await written(texts.join(' ').trim());
  if (!text) return 'No speech heard.';
  await remember(await cleaned(text, Promise.resolve(null)));
  failedSound = null;
  void ctx.events.emit({ name: 'history', data: {}, durable: false });
  return 'The text is in History.';
}

/** Ends the dictation that hears, and sends its text on its way to the window
 *  in front now. */
function finish(): void {
  const hearing = current;
  if (!hearing) return;
  current = null;
  hearing.release();
  landings += 1;
  tell({ kind: 'working', words: hud.kind === 'speaking' ? hud.words : '' });
  const front = ctx.desktop.front().catch(() => null);
  const around =
    settings.cleanUp && settings.aroundCursor
      ? ctx.desktop.around().catch(() => null)
      : Promise.resolve(null);
  landing = landing.then(async () => {
    const said = await land(hearing, await front, around);
    landings -= 1;
    armEscape();
    if (current) return;
    if (said) note(said);
    else if (landings === 0) tell({ kind: 'gone' });
  });
}

/** A press of the keys, by what the person chose them to do. */
function pressed(): void {
  if (current) finish();
  else start();
}

function released(): void {
  if (!current) return;
  const held = Date.now() - current.pressedAt;
  if (settings.keyBehaviour === 'Tap') return;
  if (settings.keyBehaviour === 'Hold or tap' && held < TAP_MS) return;
  finish();
}

/** The person meant another key. */
function cancelled(): void {
  const hearing = current;
  if (!hearing) return;
  current = null;
  armEscape();
  hearing.release();
  void hearing.dictation.drop();
  tell(landings > 0 ? { kind: 'working', words: '' } : { kind: 'gone' });
}

/** Escape: drops the dictation that hears, and else skips the clean up that runs. */
function escape(): void {
  if (current) cancelled();
  else skipCleanUp?.();
}

async function history(): Promise<History> {
  const rows = await ctx.db.query(
    'SELECT id, at, text, program FROM entries ORDER BY id DESC LIMIT ?',
    [HISTORY_MOST],
  );
  return { entries: rows as unknown as Entry[], keeps: settings.history, failed: !!failedSound };
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
    ctx.triggers.on('cancel', () => escape());
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
    async microphones() {
      const found = await ctx.capture.devices('microphone');
      return {
        options: [
          { value: '', label: 'System default' },
          ...found.map(({ name }) => ({ value: name, label: name })),
        ],
      };
    },
    async languages() {
      const facts = await speechFacts().catch(() => null);
      const known = facts?.languages ?? [];
      const named = new Intl.DisplayNames(['en'], { type: 'language' });
      return {
        options: [
          ...(facts?.detects === false && known.length > 0 ? [] : [{ value: '', label: 'Detect' }]),
          ...known
            .map((code) => ({ value: code, label: named.of(code) ?? code }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ],
      };
    },
    test_microphone: () => ({ opened: true }),
    mic_test_start: async () => {
      if (current) throw new Error('A dictation is running.');
      await startTest(ctx, settings.microphone || null);
      return { started: true };
    },
    mic_test_stop: async () => ({ seconds: await stopTest(ctx) }),
    mic_test_sound: () => ({ pcm: testSound() }),
    hear_again: async () => await hearAgain(),
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
