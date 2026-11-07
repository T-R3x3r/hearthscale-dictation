/**
 * The microphone test: up to ten seconds of the chosen microphone, for the test's
 * view to play back. The sound stays on this computer and no model hears it.
 */
import type { AppContext } from '@hearthscale/app';
import { levelOf, openMicrophone, PART_MS } from './listening.ts';

const LONGEST_MS = 10_000;

/** The id of the capture that runs. It is a promise so a stop during the start
 *  still reaches the capture. */
let capture: Promise<string> | null = null;
let parts: Uint8Array[] = [];
let unhook: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Ends the recording, and tells the view unless a new one replaces it. */
export async function stopTest(ctx: AppContext, tell = true): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  unhook?.();
  unhook = null;
  const running = capture;
  capture = null;
  if (!running) return;
  await running.then((id) => ctx.capture.stop(id)).catch(() => {});
  if (tell) void ctx.events.emit({ name: 'mic-test', data: { recording: false }, durable: false });
}

export async function startTest(ctx: AppContext, microphone: string | null): Promise<void> {
  const stopped = stopTest(ctx, false);
  parts = [];
  const opened = openMicrophone(ctx, microphone);
  capture = opened;
  timer = setTimeout(() => void stopTest(ctx), LONGEST_MS);
  const chunk = ctx.capture.on('chunk', (part) => {
    if (part.kind !== 'audio') return;
    void opened.then((own) => {
      if (part.capture !== own) return;
      parts.push(part.pcm);
      void ctx.events.emit({
        name: 'mic-test',
        data: {
          recording: true,
          level: levelOf(part.level),
          seconds: (parts.length * PART_MS) / 1000,
        },
        durable: false,
      });
    });
  });
  const ended = ctx.capture.on('ended', (gone) => {
    void opened.then((own) => {
      if (gone.capture === own) void stopTest(ctx);
    });
  });
  unhook = () => {
    chunk();
    ended();
  };
  await stopped;
  await opened;
}

/** The recording as base64 of 16 kHz mono 16-bit PCM. */
export function testSound(): string {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  let text = '';
  for (let from = 0; from < whole.length; from += 0x8000) {
    text += String.fromCharCode(...whole.subarray(from, from + 0x8000));
  }
  return btoa(text);
}
