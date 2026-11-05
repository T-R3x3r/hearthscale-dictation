/**
 * What the backend tells its views.
 */

/** What the HUD shows. `speaking` shows the voice, `working` a calm wave,
 *  `note` a few words for a moment, and `gone` nothing at all. */
export type HudState =
  | { kind: 'gone' }
  | { kind: 'speaking'; words: string }
  | { kind: 'working'; words: string }
  | { kind: 'note'; note: string };

/** The loudness of one part of sound, from 0 to 1, and of five bands in it. */
export interface Levels {
  level: number;
  bands: number[];
}

/** One dictation the history keeps. */
export interface Entry {
  id: number;
  at: number;
  text: string;
  program: string | null;
}

/** What the history at the tray icon shows. */
export interface History {
  entries: Entry[];
  keeps: boolean;
}
