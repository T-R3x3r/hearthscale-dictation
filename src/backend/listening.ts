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
const PART_MS = 100;
/** How much of a dictation must hold a voice, in milliseconds, before it is
 *  speech. A key pressed by accident, or a cough, gives no text. */
const LEAST_VOICE_MS = 200;
/** How long a dictation hears nothing before it ends, in milliseconds, so a
 *  tap by accident does not leave the microphone on. */
const SILENCE_MS = 60_000;
/** How long the model may take for the text: at least this long, in
 *  milliseconds, and at most this many times the length of the speech. */
const LONGEST_WAIT_MS = 60_000;
const WAIT_PER_SPEECH = 3;
const RATE = 16_000;
/** The most sound a dictation keeps to hear again if its model fails, 10 min. */
const MOST_KEPT_MS = 600_000;
/** The middle of each band of the HUD, in hertz. */
const BANDS = [200, 420, 900, 1700, 3000];

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Why something failed, in the platform's words without its code before them. */
export const words = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^[a-z][a-z.-]*: /, '');

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
    level: clamp((part.level + 52) / 30) ** 0.7,
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
  /** The microphone heard nothing for a long time. */
  silent(): void;
}

/** What a dictation asks of its model. */
export interface Heard {
  language: Promise<string | null>;
  dictionary: Dictionary;
  device: string | null;
  translate: boolean;
  filterSilence: boolean;
}

export class Dictation {
  private readonly stream: Promise<Listening>;
  private readonly capture: Promise<string>;
  private readonly unhook: (() => void)[];
  /** What waits to be written, in order, once the stream is open. */
  private writing: Promise<unknown>;
  private readonly startedAt = Date.now();
  private lastVoiceAt = Date.now();
  private voiceMs = 0;
  private heard: string[] = [];
  private open = '';
  private tentative = '';
  private kept: Uint8Array[] = [];
  private ended = false;
  private finish = () => {};
  private readonly done: Promise<void>;

  constructor(
    private readonly ctx: AppContext,
    options: Heard,
    private readonly hooks: Hooks,
  ) {
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.stream = this.openStream(options);
    this.writing = this.stream;
    this.unhook = [
      ctx.capture.on('chunk', (part) => this.hear(part)),
      ctx.capture.on('ended', ({ capture, reason }) => {
        void this.capture.then((own) => {
          if (capture === own && !this.ended) hooks.failed(reason);
        });
      }),
    ];
    this.capture = this.openMicrophone(options.device);
    this.capture.catch((e: unknown) => hooks.failed(words(e)));
    this.stream.catch((e: unknown) => hooks.failed(words(e)));
  }

  /** Starts the microphone the person named, or the system's. A device keeps
   *  its id only while the window runs, so the setting holds its name. */
  private async openMicrophone(name: string | null): Promise<string> {
    const found = name
      ? (await this.ctx.capture.devices('microphone')).find((device) => device.name === name)
      : undefined;
    if (name && !found) {
      throw new Error(`The microphone "${name}" is not connected. Choose another in Settings.`);
    }
    const { capture } = await this.ctx.capture.start('microphone', {
      part: PART_MS,
      ...(found && { device: found.id }),
    });
    return capture;
  }

  /** Opens a stream on the transcription model. */
  private async openStream(options: Heard): Promise<Listening> {
    const language = await options.language;
    const stream = await this.ctx.models.listen({
      pauses: false,
      ...(language && { language }),
      ...(options.dictionary.words.length > 0 && { words: options.dictionary.words }),
      ...(Object.keys(options.dictionary.aliases).length > 0 && {
        aliases: options.dictionary.aliases,
      }),
      translate: options.translate,
      filterSilence: options.filterSilence,
    });
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
    stream.on('error', ({ message }) => this.hooks.failed(message));
    stream.on('done', () => this.finish());
    return stream;
  }

  private hear(part: CapturedPart): void {
    if (part.kind !== 'audio') return;
    void this.capture.then((capture) => {
      if (part.capture !== capture) return;
      if (part.voice) {
        this.voiceMs += PART_MS;
        this.lastVoiceAt = Date.now();
      } else if (Date.now() - this.lastVoiceAt > SILENCE_MS && !this.ended) {
        this.hooks.silent();
      }
      this.hooks.levels(levelsOf(part));
      if (this.kept.length * PART_MS < MOST_KEPT_MS) this.kept.push(part.pcm);
      this.writing = this.writing.then(async () => (await this.stream).write(part.pcm));
    });
  }

  /** The text, or a failure once the model takes far too long. */
  private async text(): Promise<void> {
    const speech = Date.now() - this.startedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, refuse) => {
      timer = setTimeout(
        () => refuse(new Error('The speech model did not answer.')),
        Math.max(LONGEST_WAIT_MS, speech * WAIT_PER_SPEECH),
      );
    });
    try {
      await Promise.race([this.done, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The sound heard so far, to hear again after a failure. */
  sound(): Uint8Array[] {
    return this.kept;
  }

  /** Stops hearing and answers what was said; empty when it was no speech. */
  async end(): Promise<string> {
    if (this.ended) return '';
    this.ended = true;
    try {
      await this.ctx.capture.stop(await this.capture);
      await this.writing;
      await (await this.stream).end();
      await this.text();
    } catch (e) {
      await this.release();
      throw e;
    }
    this.unhook.forEach((off) => off());
    const text = [...this.heard, this.open, this.tentative].join(' ').trim();
    if (this.voiceMs >= LEAST_VOICE_MS && /[\p{L}\p{N}]/u.test(text)) return text;
    void this.ctx.log('info', `no speech: ${this.voiceMs} ms of voice, ${text.length} characters`);
    return '';
  }

  /** Drops everything: the person meant something else, or a part failed. */
  async drop(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.release();
  }

  private async release(): Promise<void> {
    this.unhook.forEach((off) => off());
    await this.capture.then((capture) => this.ctx.capture.stop(capture)).catch(() => {});
    await this.stream.then((stream) => stream.close()).catch(() => {});
  }
}
