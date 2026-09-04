/**
 * Latin -> fuzzy search key.
 *
 * Every name, whichever script it arrived in, ends up here: Devanagari goes
 * through `devanagariToLatin` first, typed Hinglish/English goes in directly.
 * The rules below collapse the spellings that Indian names genuinely vary
 * between — aspiration (kh/k), retroflex vs dental (t/th), sibilants
 * (s/sh/sh), v/w, z/j, f/ph, long vs short vowels — so that "Rameshwar",
 * "Rameshvar", "Ramesvar" and रामेश्वर all land on one key.
 *
 * Over-folding is deliberate: it costs a few false neighbours, which the
 * trigram similarity score then ranks below the real matches, and it buys back
 * the misses that matter far more to someone hunting for a name.
 */

/** Order matters throughout: longer patterns must be consumed first. */
const DIGRAPHS: ReadonlyArray<readonly [RegExp, string]> = [
  // "Singh" (singh) and सिंह (sinh) have to agree, so nasal+h collapses to n.
  [/ngh/g, "n"],
  [/nkh/g, "nk"],
  [/chh/g, "c"],
  [/shh/g, "s"],
  [/kh/g, "k"],
  [/gh/g, "g"],
  [/ch/g, "c"],
  [/jh/g, "j"],
  [/th/g, "t"],
  [/dh/g, "d"],
  [/ph/g, "p"],
  [/bh/g, "b"],
  [/sh/g, "s"],
  [/zh/g, "j"],
  [/ck/g, "k"],
  [/ng/g, "n"],
  [/nh/g, "n"],
  [/mh/g, "m"],
];

/** Vowel digraphs are folded before w/y become consonants. */
const VOWEL_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/aa/g, "a"],
  [/ee/g, "i"],
  [/ii/g, "i"],
  [/ie/g, "i"],
  [/oo/g, "u"],
  [/uu/g, "u"],
  [/ai/g, "e"],
  [/ay$/g, "e"],
  [/ei/g, "e"],
  [/ey/g, "e"],
  [/au/g, "o"],
  [/ou/g, "o"],
  [/ow/g, "o"],
];

const SINGLES: ReadonlyArray<readonly [RegExp, string]> = [
  [/x/g, "ks"],
  [/q/g, "k"],
  [/z/g, "j"],
  [/f/g, "p"],
  [/w/g, "v"],
];

/** Fold one already-Latin token down to its fuzzy key. */
function tokenToKey(token: string): string {
  let t = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return "";

  for (const [re, to] of DIGRAPHS) t = t.replace(re, to);
  for (const [re, to] of VOWEL_FOLDS) t = t.replace(re, to);
  for (const [re, to] of SINGLES) t = t.replace(re, to);

  t = t.replace(/y$/, "i"); // Devy -> Devi
  t = t.replace(/iy/g, "i");
  t = t.replace(/(.)\1+/g, "$1"); // Anna -> Ana
  if (t.length > 2) t = t.replace(/a$/, ""); // Sharma/शर्मा -> sarm
  t = t.replace(/(.)\1+/g, "$1");

  return t;
}

/** Latin (or Hinglish) text -> space-separated fuzzy key. */
export function latinToKey(input: string): string {
  return input
    .split(/\s+/)
    .map(tokenToKey)
    .filter(Boolean)
    .join(" ");
}

/**
 * Consonant skeleton — the key with its vowels removed (a leading vowel is
 * kept so "Anita" stays distinct from "Nita"). Much lossier than the key, so
 * it is only ever used to widen recall, never to rank:
 * "Surendra" and "Surender" both reduce to "srndr".
 */
export function latinToSkeleton(input: string): string {
  return latinToKey(input)
    .split(" ")
    .map((t) => {
      if (!t) return "";
      const head = /^[aeiou]/.test(t) ? t[0]! : "";
      return (head + t.replace(/[aeiou]/g, "")).replace(/(.)\1+/g, "$1");
    })
    .filter(Boolean)
    .join(" ");
}

/** Strip the English-side honorifics that show up in typed queries. */
export function stripLatinHonorifics(input: string): string {
  return input
    .replace(/^\s*(shri|sri|shree|smt|smt\.|mrs|mr|ms|miss|dr|late)\.?\s+/i, "")
    .trim();
}
