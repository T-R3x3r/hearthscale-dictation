/**
 * The microphone test: up to ten seconds of the chosen microphone, for the test's
 * view to play back. The sound stays on this computer and no model hears it.
 */
import type { AppContext, CapturedPart } from '@hearthscale/app';

const PART_MS = 100;
const LONGEST_MS = 10_000;

let capture: string | null = null;
let parts: Uint8Array[] = [];
let unhook: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function levelOf(part: Extract<CapturedPart, { kind: 'audio' }>): number {
  return Math.max(0, Math.min(1, (part.level + 52) / 30)) ** 0.7;
}

/** Ends the recording; answers its length in seconds. */
export async function stopTest(ctx: AppContext): Promise<number> {
  if (timer) clearTimeout(timer);
  timer = null;
  unhook?.();
  unhook = null;
  const running = capture;
  capture = null;
  if (running) {
    await ctx.capture.stop(running).catch(() => {});
    void ctx.events.emit({ name: 'mic-test', data: { recording: false }, durable: false });
  }
  return (parts.length * PART_MS) / 1000;
}

export async function startTest(ctx: AppContext, microphone: string | null): Promise<void> {
  await stopTest(ctx);
  parts = [];
  const found = microphone
    ? (await ctx.capture.devices('microphone')).find((device) => device.name === microphone)
    : undefined;
  if (microphone && !found) {
    throw new Error(`The microphone "${microphone}" is not connected.`);
  }
  const chunk = ctx.capture.on('chunk', (part) => {
    if (part.kind !== 'audio' || part.capture !== capture) return;
    parts.push(part.pcm);
    void ctx.events.emit({
      name: 'mic-test',
      data: { recording: true, level: levelOf(part), seconds: (parts.length * PART_MS) / 1000 },
      durable: false,
    });
  });
  const ended = ctx.capture.on('ended', (gone) => {
    if (gone.capture === capture) void stopTest(ctx);
  });
  unhook = () => {
    chunk();
    ended();
  };
  capture = (
    await ctx.capture.start('microphone', { part: PART_MS, ...(found && { device: found.id }) })
  ).capture;
  timer = setTimeout(() => void stopTest(ctx), LONGEST_MS);
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
