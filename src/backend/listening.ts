/**
 * One dictation's ears: the microphone from the moment of the press, and a
 * transcription stream that opens beside it. A model's cold start takes a
 * moment, so the parts wait for the stream and no first word is lost.
 *
 * With no pauses, the stream holds one segment until the end, which keeps a
 * sentence whole and its punctuation in place.
 */
import type { AppContext, CapturedPart, Listening } from '@hearthscale/app';
import type { Levels } from '../shared/types.ts';
import type { Dictionary } from './words.ts';

/** The length of a part of sound, in milliseconds. */
export const PART_MS = 100;
/** How much of a dictation must hold a voice, in milliseconds, before it is
 *  speech. A key pressed by accident, or a cough, gives no text. */
const LEAST_VOICE_MS = 200;
/** How long a dictation hears nothing before it ends, in milliseconds. */
const SILENCE_MS = 60_000;
/** The longest a dictation runs, 10 min. A key click or a room counts as voice,
 *  so silence alone may never end a dictation. */
const LONGEST_MS = 600_000;
/** How long the model may take for the text: at least this long, in
 *  milliseconds, and at most this many times the length of the speech. */
const LONGEST_WAIT_MS = 60_000;
const WAIT_PER_SPEECH = 3;
const RATE = 16_000;
/** The middle of each band of the HUD, in hertz. */
const BANDS = [200, 420, 900, 1700, 3000];

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Why something failed, in the platform's words without its code before them. */
export const words = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^[a-z][a-z.-]*: /, '');

/** The loudness of a part from its dBFS, from 0 to 1. */
export const levelOf = (dbfs: number) => clamp((dbfs + 60) / 36);

/** The strength of one frequency in a part, from 0 to 1, by Goertzel's
 *  algorithm: the HUD needs five numbers, not a spectrum. */
function bandOf(samples: Int16Array, hertz: number): number {
  const turn = (2 * Math.PI * hertz) / RATE;
  const factor = 2 * Math.cos(turn);
  let last = 0;
  let before = 0;
  for (const sample of samples) {
    const next = sample / 32768 + factor * last - before;
    before = last;
    last = next;
  }
  const power = last * last + before * before - factor * last * before;
  const amplitude = (2 * Math.sqrt(Math.max(power, 0))) / Math.max(samples.length, 1);
  return clamp((20 * Math.log10(amplitude + 1e-7) + 70) / 50);
}

function levelsOf(part: Extract<CapturedPart, { kind: 'audio' }>): Levels {
  const samples = new Int16Array(part.pcm.buffer, part.pcm.byteOffset, part.pcm.length >> 1);
  return {
    level: levelOf(part.level),
    bands: BANDS.map((hertz) => bandOf(samples, hertz)),
  };
}

export interface Hooks {
  /** The loudness of the part just heard. */
  levels(levels: Levels): void;
  /** The words so far on a model that streams, and those that may still
   *  change. */
  words(words: string, tentative: string): void;
  /** The dictation must end without the person: why, in words. */
  failed(why: string): void;
  /** The dictation ran too long with no press: a long silence or the longest
   *  time. */
  unattended(): void;
}

/** What a dictation asks of its model. */
export interface Heard {
  language: Promise<string | null>;
  dictionary: Dictionary;
  translate: boolean;
  filterSilence: boolean;
}

/** Starts the microphone the person named, or the system's. A device keeps its
 *  id only while the window runs, so the setting holds its name. */
export async function openMicrophone(ctx: AppContext, name: string | null): Promise<string> {
  const found = name
    ? (await ctx.capture.devices('microphone')).find((device) => device.name === name)
    : undefined;
  if (name && !found) {
    throw new Error(`The microphone "${name}" is not connected. Choose another in Settings.`);
  }
  const { capture } = await ctx.capture.start('microphone', {
    part: PART_MS,
    ...(found && { device: found.id }),
  });
  return capture;
}

/** Opens a stream on the transcription model. */
async function openStream(ctx: AppContext, options: Heard): Promise<Listening> {
  const language = await options.language;
  return ctx.models.listen({
    pauses: false,
    ...(language && { language }),
    ...(options.dictionary.words.length > 0 && { words: options.dictionary.words }),
    ...(Object.keys(options.dictionary.aliases).length > 0 && {
      aliases: options.dictionary.aliases,
    }),
    translate: options.translate,
    filterSilence: options.filterSilence,
  });
}

/** Answers as `work` does, or fails once the model takes far too long for
 *  `speech` milliseconds of sound. */
function inTime<T>(work: Promise<T>, speech: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, refuse) => {
    timer = setTimeout(
      () => refuse(new Error('No answer came from the speech model.')),
      Math.max(LONGEST_WAIT_MS, speech * WAIT_PER_SPEECH),
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The text of sound already kept, from a new stream. */
export async function transcribe(
  ctx: AppContext,
  options: Heard,
  sound: Uint8Array[],
): Promise<string> {
  const opened = openStream(ctx, options);
  const hear = async () => {
    const stream = await opened;
    const texts: string[] = [];
    const done = new Promise<void>((resolve, refuse) => {
      stream.on('segment', ({ text }) => texts.push(text));
      stream.on('error', ({ message }) => refuse(new Error(message)));
      stream.on('done', () => resolve());
    });
    for (const part of sound) await stream.write(part);
    await stream.end();
    await done;
    return texts.join(' ').trim();
  };
  try {
    return await inTime(hear(), sound.length * PART_MS);
  } finally {
    void opened.then((stream) => stream.close()).catch(() => {});
  }
}

export class Dictation {
  private readonly stream: Promise<Listening>;
  private readonly capture: Promise<string>;
  private readonly unhook: (() => void)[];
  /** The last part written, which leaves after the ones before it. */
  private writing: Promise<unknown> = Promise.resolve();
  private readonly startedAt = Date.now();
  private lastVoiceAt = Date.now();
  private voiceMs = 0;
  private heard: string[] = [];
  private open = '';
  private tentative = '';
  private kept: Uint8Array[] = [];
  private ended = false;
  private dropped = false;
  private finish = () => {};
  private readonly done: Promise<void>;

  constructor(
    private readonly ctx: AppContext,
    options: Heard,
    device: string | null,
    private readonly hooks: Hooks,
  ) {
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.stream = openStream(ctx, options).then((stream) => {
      stream.on('partial', ({ text, tentative }) => {
        this.open = text;
        this.tentative = tentative ?? '';
        this.hooks.words([...this.heard, text].join(' '), this.tentative);
      });
      stream.on('segment', ({ text }) => {
        this.open = '';
        this.tentative = '';
        if (text.trim()) this.heard.push(text.trim());
      });
      stream.on('error', ({ message }) => this.fail(message));
      stream.on('done', () => this.finish());
      return stream;
    });
    this.unhook = [
      ctx.capture.on('chunk', (part) => this.hear(part)),
      ctx.capture.on('ended', ({ capture, reason }) => {
        void this.capture.then((own) => {
          if (capture === own && !this.ended) this.fail(reason);
        });
      }),
    ];
    this.capture = openMicrophone(ctx, device);
    this.capture.catch((e: unknown) => this.fail(words(e)));
    this.stream.catch((e: unknown) => this.fail(words(e)));
  }

  private fail(why: string): void {
    if (!this.dropped) this.hooks.failed(why);
  }

  private hear(part: CapturedPart): void {
    if (part.kind !== 'audio') return;
    void this.capture.then((capture) => {
      if (part.capture !== capture) return;
      if (part.voice) {
        this.voiceMs += PART_MS;
        this.lastVoiceAt = Date.now();
      }
      this.kept.push(part.pcm);
      const quiet = Date.now() - this.lastVoiceAt > SILENCE_MS;
      if (!this.ended && (quiet || this.kept.length * PART_MS >= LONGEST_MS)) {
        this.hooks.unattended();
      }
      this.hooks.levels(levelsOf(part));
      const sent = this.stream.then((stream) => stream.write(part.pcm));
      sent.catch((e: unknown) => this.fail(words(e)));
      this.writing = sent;
    });
  }

  private async closed(): Promise<void> {
    await this.ctx.capture.stop(await this.capture);
    await this.writing;
    await (await this.stream).end();
    await this.done;
  }

  /** The sound heard so far, to hear again after a failure. */
  sound(): Uint8Array[] {
    return this.kept;
  }

  /** Stops hearing and answers what was said: empty when it was no speech, and
   *  null when the dictation was dropped. A failure goes to the `failed` hook. */
  async end(): Promise<string | null> {
    this.ended = true;
    try {
      await inTime(Promise.race([this.closed(), this.done]), Date.now() - this.startedAt);
    } catch (e) {
      this.fail(words(e));
    }
    if (this.dropped) return null;
    this.unhook.forEach((off) => off());
    const text = [...this.heard, this.open, this.tentative].join(' ').trim();
    if (this.voiceMs >= LEAST_VOICE_MS && /[\p{L}\p{N}]/u.test(text)) return text;
    void this.ctx.log('info', `no speech: ${this.voiceMs} ms of voice, ${text.length} characters`);
    return '';
  }

  /** Drops everything: the person meant something else, or a part failed. */
  async drop(): Promise<void> {
    this.dropped = true;
    this.finish();
    this.unhook.forEach((off) => off());
    await this.capture.then((capture) => this.ctx.capture.stop(capture)).catch(() => {});
    await this.stream.then((stream) => stream.close()).catch(() => {});
  }
}
