/**
 * Which speech models Dictation recommends, from what each model's card measured:
 * the best all round, the one with the fewest errors, and the fastest on a processor,
 * by Handy's method (MIT, `LICENSE-Handy`).
 */

/** The wait that counts for nothing, in seconds, and how much each second past it
 *  weighs against a percent of errors. */
const FREE_WAIT = 3;
const WAIT_WEIGHT = 0.5;
/** The longest wait of a recommended model, a fast one on a processor and an accurate
 *  one, in seconds. */
const BEST_WAIT = 5;
const FAST_WAIT = 4;
const ACCURATE_WAIT = 10;
/** The errors above which a model is no use for a language, in percent. */
const USABLE_ERRORS = 20;

export interface Search {
  languages: string[];
  models: {
    repo: string;
    speech: {
      errors: Record<string, number>;
      seconds: number | null;
      processorSeconds: number | null;
    } | null;
  }[];
}

interface Scored {
  repo: string;
  error: number;
  worst: number;
  wait: number;
  slow: number | null;
}

const fewest = (rows: Scored[], measure: (row: Scored) => number): Scored | undefined =>
  rows.reduce<Scored | undefined>(
    (held, row) => (held && measure(held) <= measure(row) ? held : row),
    undefined,
  );

/** The models to recommend for the languages, the one recommended most first. A model
 *  with no measurement of each language is not among them. */
export function recommend({ languages, models }: Search): { repo: string; word: string }[] {
  if (languages.length === 0) return [];
  const scored = models.flatMap(({ repo, speech }): Scored[] => {
    const errors = languages.map((language) => speech?.errors[language]);
    const wait = speech?.seconds;
    if (wait == null || errors.some((one) => one === undefined)) return [];
    const measured = errors as number[];
    return [
      {
        repo,
        error: Math.exp(measured.reduce((sum, one) => sum + Math.log(one), 0) / measured.length),
        worst: Math.max(...measured),
        wait,
        slow: speech?.processorSeconds ?? null,
      },
    ];
  });
  const usable = scored.filter(({ worst }) => worst < USABLE_ERRORS);
  const pool = usable.length > 0 ? usable : scored;
  const among = (within: number) => {
    const held = pool.filter(({ wait }) => wait <= within);
    return held.length > 0 ? held : pool;
  };
  const best = fewest(
    among(BEST_WAIT),
    ({ error, wait }) => error + WAIT_WEIGHT * Math.max(wait - FREE_WAIT, 0),
  );
  const accurate = fewest(among(ACCURATE_WAIT), ({ error }) => error);
  const fast = fewest(
    pool.filter(({ slow }) => slow !== null && slow <= FAST_WAIT),
    ({ error }) => error,
  );
  const words: [Scored | undefined, string][] = [
    [best, 'Recommended'],
    [accurate, 'Most accurate'],
    [fast, 'Fastest'],
  ];
  const named = new Map<string, string>();
  for (const [row, word] of words) {
    if (row && !named.has(row.repo)) named.set(row.repo, word);
  }
  return [...named].map(([repo, word]) => ({ repo, word }));
}
