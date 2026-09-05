/**
 * Expanding the abbreviations the roll actually prints.
 *
 * Clerks shorten मोहम्मद constantly, and inconsistently: this ward alone has
 * "मो॰हनीफ" (abbreviation sign, no space), "मो॰ हनीफ" (sign and space), "मो.
 * इकबाल" (full stop), "मो हुसैन" (bare) and "मो॰हम्मद ईस्माइल" (the sign inside
 * the word). Someone searching "Mohammad Hanif" should find every one of them.
 *
 * Expansion happens only on the way to the SEARCH KEY. The stored Devanagari
 * keeps whatever the roll printed — the display value is never rewritten.
 */

/** U+0970 DEVANAGARI ABBREVIATION SIGN, plus the ASCII stops used for it. */
const ABBREV_MARK = /[॰॰.]/;

interface Expansion {
  /** Matches the abbreviated token, with or without its trailing mark. */
  test: RegExp;
  to: string;
}

const DEVANAGARI: Expansion[] = [
  { test: /^मो[॰.]?$/, to: "मोहम्मद" },
  { test: /^मु[॰.]?$/, to: "मुहम्मद" },
  { test: /^मु?ह[॰.]?$/, to: "मोहम्मद" },
  { test: /^अ[॰.]$/, to: "अब्दुल" },
  { test: /^डॉ[॰.]?$/, to: "डॉक्टर" },
  { test: /^स्व[॰.]?$/, to: "स्वर्गीय" },
];

const LATIN: Expansion[] = [
  { test: /^(?:md|mohd|moh|mo)\.?$/i, to: "mohammad" },
  { test: /^(?:abd)\.?$/i, to: "abdul" },
  { test: /^(?:dr)\.?$/i, to: "doctor" },
];

/** Split "मो॰हनीफ" into ["मो॰", "हनीफ"] — the sign glues words together. */
function splitOnMark(token: string): string[] {
  const i = token.search(ABBREV_MARK);
  if (i <= 0 || i === token.length - 1) return [token];
  return [token.slice(0, i + 1), token.slice(i + 1)];
}

function expandWith(text: string, table: Expansion[]): string {
  return text
    .split(/\s+/)
    .flatMap(splitOnMark)
    .map((t) => table.find((e) => e.test.test(t))?.to ?? t)
    .filter(Boolean)
    .join(" ");
}

/** Expand Devanagari abbreviations ahead of transliteration. */
export function expandDevanagariAbbreviations(text: string): string {
  return expandWith(text, DEVANAGARI);
}

/** Expand Latin abbreviations ahead of folding. */
export function expandLatinAbbreviations(text: string): string {
  return expandWith(text, LATIN);
}
