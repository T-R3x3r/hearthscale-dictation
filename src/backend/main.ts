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
import type { AppContext, Backend, HotkeyFire, ModelKind, ProgramFire } from '@hearthscale/app';
import type { Entry, History, HudState, Levels } from '../shared/types.ts';
import { cleanUp, runsLines, type Around } from './cleanup.ts';
import { Dictation, transcribe, words as reason, type Heard } from './listening.ts';
import { startTest, stopTest, testSound } from './micTest.ts';
import { recommend, type Search } from './recommend.ts';
import { dictionaryOf, withAliases, withoutFillers, type Dictionary } from './words.ts';

interface Settings {
  keyBehaviour: 'Hold or tap' | 'Hold' | 'Tap';
  insert: 'Automatic' | 'Type' | 'Paste';
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
  language: Promise<string | null>;
  /** The chat model that may clean up the text, by its card. */
  chat: Promise<string | null>;
}

/** A press shorter than this, in milliseconds, is a tap, which keeps the
 *  dictation going until the next press. */
const TAP_MS = 300;
/** A press and a release closer than this, in milliseconds, came together, as a
 *  backend that starts hears them. No hand taps this fast. */
const HANDED_OVER_MS = 30;
/** The longest text that Automatic types; pasting is faster above it. */
const TYPED_MOST = 200;
/** The most characters the platform types at once. */
const TYPE_LIMIT = 2000;
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
/** The dictation whose text is next to land. */
let atTurn: Hearing | null = null;
/** Ends the clean up that runs now, whose words then go in as they were heard. */
let skipCleanUp: (() => void) | null = null;
/** The hotkey that cancels holds its key. */
let armed = false;
/** The sound of the last dictation that failed, until the next one lands. */
let failedSound: Uint8Array[] | null = null;
/** The last text that no entry holds, until the next one lands. */
let lastText: string | null = null;

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

const historyChanged = () => void ctx.events.emit({ name: 'history', data: {}, durable: false });

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

const heardWith = (language: Promise<string | null>): Heard => ({
  language,
  dictionary: dictionary(),
  translate: settings.translate,
  filterSilence: settings.filterSilence,
});

const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, ' ');

/** Holds Escape while a dictation runs, and only then. */
function armEscape(): void {
  const wanted = current !== null || landings > 0;
  if (wanted === armed) return;
  armed = wanted;
  void ctx.triggers.hotkeys
    .arm('cancel', wanted)
    .catch((e: unknown) => void ctx.log('warn', `Escape was not held: ${reason(e)}`));
}

/** The model this app runs a kind on, and where the choice comes from. */
async function modelOf(kind: ModelKind) {
  const { cards, chosen } = await ctx.models.list({ kind });
  const choice = chosen[kind];
  if (!choice || choice.card === null) return null;
  const { card: id, source } = choice;
  const card = cards.find((listed) => listed.id === id);
  return card ? { card, source } : null;
}

/** The language a dictation asks for: the one the person speaks where the model
 *  hears it, and else the model's only one or none, for the model to tell. A model
 *  that cannot tell takes the first language the person speaks that it hears, or
 *  English, or its first. */
async function languageNow(): Promise<string | null> {
  const model = await modelOf('transcription').catch(() => null);
  const facts = model?.card.speech;
  const known = facts?.languages ?? [];
  if (known.length === 1) return known[0]!;
  const spoken = await ctx.models.languages().catch((): string[] => []);
  const only = spoken.length === 1 ? spoken[0]! : null;
  if (only && (known.length === 0 || known.includes(only))) return only;
  if (facts?.detects !== false) return null;
  return (
    spoken.find((language) => known.includes(language)) ??
    (known.includes('en') ? 'en' : (known[0] ?? null))
  );
}

/** The chat model the clean up may use. The words and the text around the cursor
 *  reach a cloud model only where the person chose it for this app. */
async function chatCard(): Promise<string | null> {
  if (!settings.cleanUp) return null;
  const model = await modelOf('chat').catch(() => null);
  if (!model) return null;
  if (model.card.location === 'cloud' && model.source !== 'app') {
    void ctx.log('info', 'the clean up skips a cloud model that was not chosen for this app');
    return null;
  }
  return model.card.id;
}

/** Loads a cold chat model while the person speaks, so the clean up does not
 *  wait for it after they let go. */
async function warmUp(chat: Promise<string | null>): Promise<void> {
  const model = await chat;
  if (!model) return;
  try {
    const answer = ctx.models.complete({
      model,
      messages: [{ role: 'user', content: 'ok' }],
      reasoning: 'none',
      sampling: { maxTokens: 1 },
    });
    for await (const delta of answer) void delta;
  } catch (e) {
    void ctx.log('info', `the chat model did not warm up: ${reason(e)}`);
  }
}

/** The text around the cursor, where the clean up may read it. A browser gives
 *  the text of a field only a moment after a program first asks, so an ask while
 *  the person speaks readies the one at the end. */
const aroundNow = (chat: Promise<string | null>): Promise<Around | null> =>
  chat
    .then((model) => (model && settings.aroundCursor ? ctx.desktop.around() : null))
    .catch(() => null);

function start(): void {
  void showHud();
  let release = () => {};
  const letGo = new Promise<void>((resolve) => (release = resolve));
  const language = languageNow();
  const hearing: Hearing = {
    pressedAt: Date.now(),
    letGo,
    release,
    failed: null,
    language,
    chat: chatCard(),
    dictation: new Dictation(ctx, heardWith(language), settings.microphone || null, {
      levels: (levels: Levels) =>
        void ctx.events.emit({ name: 'levels', data: levels, durable: false }),
      words: (said, tentative) => {
        if (current && current !== hearing) return;
        if (hud.kind === 'speaking' || hud.kind === 'working') {
          tell({ ...hud, words: said, tentative });
        }
      },
      failed: (why) => fail(hearing, why),
      unattended: () => {
        if (current === hearing) finish(false);
      },
    }),
  };
  current = hearing;
  armEscape();
  const speaking = () => {
    void warmUp(hearing.chat);
    void aroundNow(hearing.chat);
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
  historyChanged();
}

/** Puts the text in the window `front`. A typed line break is the Enter key,
 *  which sends a message in a chat program, so a text of several lines goes by
 *  paste, or as one line when the person asked for typing. */
async function insert(text: string, front: string): Promise<void> {
  const byChoice = settings.insert === 'Type';
  const line = byChoice ? oneLine(text) : text;
  const typed = byChoice
    ? line.length <= TYPE_LIMIT
    : settings.insert === 'Automatic' && !line.includes('\n') && line.length <= TYPED_MOST;
  if (typed) await ctx.desktop.type(line, { front });
  else await ctx.desktop.paste(line, { front });
}

/** Keeps a text where History shows it: an entry, or in memory while the history
 *  is off or cannot take it. */
async function remember(text: string): Promise<void> {
  if (settings.history) {
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
    } catch (e) {
      void ctx.log('warn', `the history kept nothing: ${reason(e)}`);
      lastText = text;
    }
  } else lastText = text;
  historyChanged();
}

/** Lands one dictation's text; answers what the HUD says of it, if anything. */
async function land(
  hearing: Hearing,
  ended: Promise<string | null>,
  front: string | null,
  around: Promise<Around | null>,
): Promise<string | null> {
  const said = await ended;
  if (said === null) return hearing.failed;
  const heard = written(said, await hearing.language);
  if (!heard) return 'No speech heard.';
  const field = await around;
  const secret = field?.password === true;
  const skip = new AbortController();
  skipCleanUp = () => skip.abort();
  const clean = secret ? heard : await cleaned(heard, hearing.chat, field, skip.signal);
  skipCleanUp = null;
  const text = runsLines(program) ? oneLine(clean) : clean;
  failedSound = null;
  if (!secret) await remember(text);
  if (front) {
    await current?.letGo;
    try {
      await insert(text, front);
      if (lastText !== null) {
        lastText = null;
        historyChanged();
      }
      return null;
    } catch (e) {
      void ctx.log('warn', `the text was not inserted: ${reason(e)}`);
    }
  }
  return secret ? 'The text could not be inserted.' : 'The text is in History.';
}

/** The heard words without their filler sounds, where the person wants them out. */
function written(heard: string, language: string | null): string {
  return settings.removeFillers ? withoutFillers(heard, language, settings.correction) : heard;
}

/** The heard words after the chat model, where the person wants it and may use it. */
async function cleaned(
  heard: string,
  chat: Promise<string | null>,
  around: Around | null,
  skip: AbortSignal,
): Promise<string> {
  const model = await chat;
  if (!model) return heard;
  const { words, aliases } = dictionary();
  const clean = await cleanUp(ctx, heard, {
    model,
    program,
    styles: settings.styles,
    words,
    instructions: settings.instructionsKind === 'Your own' ? settings.instructions : null,
    correction: settings.correction,
    around,
    skip,
  });
  return withAliases(clean, aliases);
}

/** Hears the sound of the dictation that failed again; the text goes to History. */
async function hearAgain(): Promise<void> {
  const sound = failedSound;
  if (!sound) return;
  const language = languageNow();
  const text = written(await transcribe(ctx, heardWith(language), sound), await language);
  if (!text) throw new Error('No speech heard.');
  const clean = await cleaned(text, chatCard(), null, new AbortController().signal);
  failedSound = null;
  await remember(clean);
}

/** Ends the dictation that hears and sends its text on its way: to the window in
 *  front now where the person ended it, and else only to History. */
function finish(byPerson = true): void {
  const hearing = current;
  if (!hearing) return;
  current = null;
  hearing.release();
  landings += 1;
  tell({ kind: 'working', words: hud.kind === 'speaking' ? hud.words : '' });
  const ended = hearing.dictation.end();
  const front = byPerson ? ctx.desktop.front().catch(() => null) : Promise.resolve(null);
  const around = byPerson ? aroundNow(hearing.chat) : Promise.resolve(null);
  landing = landing.then(async () => {
    atTurn = hearing;
    const said = await land(hearing, ended, await front, around);
    atTurn = null;
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
  if (settings.keyBehaviour === 'Hold or tap' && held >= HANDED_OVER_MS && held < TAP_MS) return;
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

/** Escape: drops the dictation that hears, skips the clean up that runs, and
 *  else drops the text that waits for its model. */
function escape(): void {
  if (current) cancelled();
  else if (skipCleanUp) skipCleanUp();
  else void atTurn?.dictation.drop();
}

/** Follows the hotkey's keys: a key alone holds the HUD back a moment. */
function keysChanged(hotkeys: { name: string; keys?: string }[]): void {
  const keys = hotkeys.find((key) => key.name === 'dictate')?.keys;
  keyAlone = !!keys && (!keys.includes('+') || /Left|Right/.test(keys));
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
    if (!settings.history) await ctx.db.exec('DELETE FROM entries');
    keysChanged(await ctx.triggers.hotkeys.list());
    ctx.settings.on('changed', (values) => {
      const before = settings.history;
      settings = values as unknown as Settings;
      if (before && !settings.history) void ctx.db.exec('DELETE FROM entries');
      historyChanged();
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
    async history() {
      const rows = await ctx.db.query(
        'SELECT id, at, text, program FROM entries ORDER BY id DESC LIMIT ?',
        [HISTORY_MOST],
      );
      return {
        entries: rows as unknown as Entry[],
        keeps: settings.history,
        failed: !!failedSound,
        text: lastText,
      } satisfies History;
    },
    recommend_models: (input) => ({ recommended: recommend(input as unknown as Search) }),
    async microphones() {
      const found = await ctx.capture.devices('microphone');
      return {
        options: [
          { value: '', label: 'System default' },
          ...found.map(({ name }) => ({ value: name, label: name })),
        ],
      };
    },
    test_microphone: () => ({ opened: true }),
    mic_test_start: async () => {
      if (current) throw new Error('A dictation is running.');
      await startTest(ctx, settings.microphone || null);
      return { started: true };
    },
    mic_test_stop: async () => {
      await stopTest(ctx);
      return { stopped: true };
    },
    mic_test_sound: () => ({ pcm: testSound() }),
    hear_again: async () => {
      await hearAgain();
      return { heard: true };
    },
    async forget(input) {
      await ctx.db.exec('DELETE FROM entries WHERE id = ?', [(input as { id: number }).id]);
      return { forgotten: true };
    },
    async forget_all() {
      await ctx.db.exec('DELETE FROM entries');
      lastText = null;
      failedSound = null;
      historyChanged();
      return 'The history is empty.';
    },
  },
};

export default backend;
