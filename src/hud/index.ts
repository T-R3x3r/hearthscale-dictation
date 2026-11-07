/**
 * The HUD: seven capsule stripes on a centre line, in the gold fade, on the
 * colour blobs of the app background. The voice spreads from the centre
 * outward. It stays loaded between dictations and reports an empty size, so
 * it shows at once.
 */
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import type { HudState, Levels } from '../shared/types.ts';
import sheet from './hud.css?inline';

const COUNT = 7;
const BAR = 4;
const STEP = 6.5;
const MAX = 38;
const HEIGHT = 44;
const SPAN = STEP * (COUNT - 1) + BAR;
const WIDTH = Math.round(SPAN + 34);
const MIDDLE = (COUNT - 1) / 2;
/** The most lines of words the plate shows. */
const LINES = 3;
/** How fast a stripe rises and falls, how much it flickers and how fast, and
 *  how slowly the voice spreads outward, in seconds a stripe. */
const RISE = 0.6;
const FALL = 0.2;
const FLICK = 0.22;
const FLICK_RATE = 3.4;
const SPREAD = 0.07;
/** The loudest part lately sets the top of the stripes, so a quiet microphone moves
 *  them as far as a loud one: how much of it each part keeps, and the least it counts
 *  for, so that a quiet room stays low. */
const PEAK_KEEPS = 0.97;
const PEAK_LEAST = 0.45;
/** How far behind the sound the stripes read it: the time between two parts,
 *  so they move between the parts and not in steps. */
const BEHIND_S = 0.1;
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;

const NS = 'http://www.w3.org/2000/svg';
const style = document.createElement('style');
style.textContent = sheet;
document.head.append(style);

const clamp = (x: number, low = 0, high = 1) => Math.max(low, Math.min(high, x));
const wobble = (t: number, seed: number) =>
  (Math.sin(t * 1.7 + seed) + Math.sin(t * 3.1 + seed * 2.3) + Math.sin(t * 5.3 + seed * 3.7)) / 3;

const root = document.createElement('div');
root.className = 'hud-root';
const wordsBox = document.createElement('div');
wordsBox.className = 'hud-words';
const wordsText = document.createElement('div');
wordsText.className = 'hud-words-text';
const settledWords = document.createElement('span');
const tentativeWords = document.createElement('span');
tentativeWords.className = 'hud-words-tentative';
wordsText.append(settledWords, tentativeWords);
wordsBox.append(wordsText);
const plate = document.createElement('div');
plate.className = 'hud-plate';
const noteBox = document.createElement('div');
noteBox.className = 'hud-note';
const svg = document.createElementNS(NS, 'svg');
svg.setAttribute('width', String(WIDTH));
svg.setAttribute('height', String(HEIGHT));
svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
const defs = document.createElementNS(NS, 'defs');
const fade = document.createElementNS(NS, 'linearGradient');
fade.id = 'fade';
fade.setAttribute('gradientUnits', 'userSpaceOnUse');
for (const [name, value] of [['x1', 0], ['x2', 0], ['y1', 3], ['y2', 41]] as const) {
  fade.setAttribute(name, String(value));
}
for (const [offset, token] of [[0, '--mark-hi'], [0.5, '--mark-lo'], [1, '--mark-hi']] as const) {
  const stop = document.createElementNS(NS, 'stop');
  stop.setAttribute('offset', String(offset));
  stop.setAttribute('style', `stop-color: var(${token})`);
  fade.append(stop);
}
defs.append(fade);
svg.append(defs);
const left = (WIDTH - SPAN) / 2;
const stripes = Array.from({ length: COUNT }, (_, i) => {
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', String(left + i * STEP));
  rect.setAttribute('width', String(BAR));
  rect.setAttribute('rx', String(BAR / 2));
  rect.setAttribute('fill', 'url(#fade)');
  svg.append(rect);
  return rect;
});
plate.append(wordsBox, svg, noteBox);
root.append(plate);
document.body.append(root);

const app = new App({ name: 'Dictation HUD', version: '0.1.0' }, {}, { autoResize: false });

let state: HudState = { kind: 'gone' };
/** Each part heard lately, newest last, with when it came. */
const parts: (Levels & { at: number })[] = [];
const heights = new Array<number>(COUNT).fill(0.1);
let peak = 0;
let lastFrame = 0;
let running = false;

/** The loudness `delay` seconds ago, between the two parts around it. */
function read(now: number, delay: number): Levels {
  const at = now - delay;
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const newer = parts[i]!;
    const older = parts[i - 1]!;
    if (older.at <= at) {
      const mix = clamp((at - older.at) / Math.max(newer.at - older.at, 1e-3));
      return {
        level: older.level + (newer.level - older.level) * mix,
        bands: older.bands.map((band, b) => band + ((newer.bands[b] ?? 0) - band) * mix),
      };
    }
  }
  return parts[0] ?? { level: 0, bands: [0, 0, 0, 0, 0] };
}

function frame(ms: number): void {
  if (state.kind !== 'speaking' && state.kind !== 'working') {
    running = false;
    return;
  }
  const now = ms / 1000;
  const dt = lastFrame ? Math.min(now - lastFrame, 0.1) : 1 / 60;
  lastFrame = now;
  stripes.forEach((rect, i) => {
    const away = Math.abs(i - MIDDLE) / MIDDLE;
    let target: number;
    if (state.kind === 'working') {
      target = CALM
        ? 0.25
        : 0.14 + 0.2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (now / 1.8 - Math.abs(i - MIDDLE) / COUNT)));
    } else {
      const past = read(now, BEHIND_S + Math.abs(i - MIDDLE) * SPREAD);
      const level = past.level / Math.max(peak, PEAK_LEAST);
      const flick = CALM ? 0 : wobble(now * FLICK_RATE, i * 1.9) * FLICK * level;
      const band = past.bands[i % past.bands.length] ?? 0;
      target = clamp(0.05 + (1.1 - 0.35 * away * away) * level * (0.6 + 0.4 * band) + flick, 0.05, 1);
    }
    const rate = target > heights[i]! ? RISE : FALL;
    heights[i]! += (target - heights[i]!) * (1 - Math.pow(1 - rate, dt * 60));
    const size = Math.max(BAR, heights[i]! * MAX);
    rect.setAttribute('height', String(size));
    rect.setAttribute('y', String(HEIGHT / 2 - size / 2));
  });
  requestAnimationFrame(frame);
}

/** The window's one size while the HUD shows, or an empty one, which hides it. */
function fit(shown: boolean): void {
  const box = root.getBoundingClientRect();
  void app.sendSizeChanged(
    shown ? { width: Math.ceil(box.width), height: Math.ceil(box.height) } : { width: 0, height: 0 },
  );
}

/** Shows the words in a box as tall as their lines, up to the most it holds:
 *  those that no longer change, then in a dimmer colour those that may. */
function showWords(said: string, tentative: string): void {
  const any = said !== '' || tentative !== '';
  root.dataset.words = String(any);
  if (settledWords.textContent !== said) settledWords.textContent = said;
  const after = said && tentative ? ` ${tentative}` : tentative;
  if (tentativeWords.textContent !== after) tentativeWords.textContent = after;
  const style = getComputedStyle(wordsText);
  const most = LINES * parseFloat(style.lineHeight) + parseFloat(style.paddingTop);
  const height = any ? wordsText.offsetHeight : 0;
  wordsBox.style.height = `${Math.min(height, most)}px`;
  wordsBox.dataset.more = String(height > most);
}

function show(next: HudState): void {
  const was = state.kind;
  state = next;
  root.dataset.state = next.kind;
  noteBox.textContent = next.kind === 'note' ? next.note : '';
  const hearing = next.kind === 'speaking' || next.kind === 'working';
  showWords(hearing ? next.words : '', hearing ? (next.tentative ?? '') : '');
  if (next.kind === 'speaking' && was !== 'speaking') {
    parts.length = 0;
    peak = 0;
  }
  if ((next.kind === 'speaking' || next.kind === 'working') && !running) {
    running = true;
    lastFrame = 0;
    requestAnimationFrame(frame);
  }
  if (next.kind === 'gone') {
    if (was === 'gone') return;
    if (CALM) {
      fit(false);
      return;
    }
    root.dataset.entering = 'false';
    root.dataset.leaving = 'true';
    return;
  }
  root.dataset.leaving = 'false';
  if (was === 'gone') {
    root.dataset.entering = 'true';
    fit(true);
  }
}

plate.addEventListener('animationend', () => {
  root.dataset.entering = 'false';
  if (root.dataset.leaving === 'true') {
    root.dataset.leaving = 'false';
    fit(false);
  }
});

let told = false;

app.fallbackNotificationHandler = async ({ method, params }) => {
  if (method !== 'hearthscale/events/event') return;
  const { name, data } = params as { name: string; data: unknown };
  if (name === 'hud') {
    told = true;
    show(data as HudState);
  } else if (name === 'levels') {
    const part = data as Levels;
    peak = Math.max(part.level, peak * PEAK_KEEPS);
    parts.push({ ...part, at: performance.now() / 1000 });
    if (parts.length > 40) parts.shift();
  }
};

await app.connect(new PostMessageTransport(window.parent, window.parent));
fit(false);
const first = await app.callServerTool({ name: 'hud_state', arguments: {} });
if (!told) show((first.structuredContent as { state: HudState }).state);
