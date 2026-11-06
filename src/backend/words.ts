/**
 * What the person wrote in the dictionary, and the text steps that need no
 * model: the filler words of a language, and an alias back to its term after the
 * chat model rewrote the text. The filler words follow T3 Code's list (MIT).
 */

/** The dictionary's entries as a stream takes them. */
export interface Dictionary {
  words: string[];
  aliases: Record<string, string[]>;
}

/** Reads entries such as `Parakeet` and `Parakeet = para keet, para-keet`. */
export function dictionaryOf(entries: string[]): Dictionary {
  const words: string[] = [];
  const aliases: Record<string, string[]> = {};
  for (const entry of entries) {
    const [term, others] = entry.split('=', 2).map((part) => part.trim());
    if (!term) continue;
    words.push(term);
    const spelled = (others ?? '')
      .split(',')
      .map((other) => other.trim())
      .filter(Boolean);
    if (spelled.length > 0) aliases[term] = spelled;
  }
  return { words, aliases };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Spells each alias in a text as its term. */
export function withAliases(text: string, aliases: Record<string, string[]>): string {
  const spellings = Object.entries(aliases)
    .flatMap(([term, others]) => others.map((other) => ({ other, term })))
    .sort((a, b) => b.other.length - a.other.length);
  if (spellings.length === 0) return text;
  const terms = new Map(spellings.map(({ other, term }) => [other.toLowerCase(), term]));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${spellings.map(({ other }) => escaped(other)).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  return text.replace(pattern, (found) => terms.get(found.toLowerCase()) ?? found);
}

const ANY_LANGUAGE = ['uh', 'uhm', 'umm', 'uhh', 'uhhh', 'ehh', 'ehm', 'ahm', 'hmm', 'hm', 'mmm', 'хм', 'ммм'];
const BY_LANGUAGE: Record<string, string[]> = {
  en: ['um', 'ah', 'eh'],
  de: ['äh', 'ähm'],
  fr: ['euh'],
};

/** Takes the hesitation sounds out of a text, and leaves a correction word
 *  where it is. */
export function withoutFillers(text: string, language: string | null, keep: string): string {
  const fillers = [...ANY_LANGUAGE, ...(BY_LANGUAGE[language ?? ''] ?? [])];
  const kept = keep.trim().split(/\s+/).filter(Boolean).map(escaped).join('\\s+');
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:(${kept || '(?!)'})(?![\\p{L}\\p{N}_])|(?:${fillers.map(escaped).join('|')})(?![\\p{L}\\p{N}_])[,.]?)`,
    'giu',
  );
  return text
    .replace(pattern, (_found, word: string | undefined) => word ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
