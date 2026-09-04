/**
 * Shared name-normalisation used by BOTH the PDF importer and the web search
 * box. That is the whole trick: a stored name and a typed query are pushed
 * through the identical pipeline, so they can be compared as plain strings no
 * matter which script either of them started in.
 *
 *   Devanagari ─┐
 *               ├─> readable Latin ─> fuzzy key ─> consonant skeleton
 *   Hinglish  ──┘
 */

export {
  detectScript,
  devanagariToLatin,
  hasDevanagari,
  normalizeDevanagari,
} from "./devanagari.ts";
export { latinToKey, latinToSkeleton, stripLatinHonorifics } from "./latin.ts";

import {
  detectScript,
  devanagariToLatin,
  hasDevanagari,
  normalizeDevanagari,
} from "./devanagari.ts";
import { latinToKey, latinToSkeleton, stripLatinHonorifics } from "./latin.ts";

/** The four forms of a name that get stored on (or compared against) a row. */
export interface NameForms {
  /** Cleaned Devanagari, exactly as it should be shown to a reader. */
  hi: string;
  /** Readable romanisation, e.g. रामेश्वर -> "rameshvar". */
  latin: string;
  /** Lossy fuzzy key — the primary match column. */
  key: string;
  /** Vowel-free skeleton — the widest recall fallback. */
  skeleton: string;
}

/**
 * Build every search form for one name field, from input in either script.
 * A Devanagari name keeps its original for display; a Latin name gets an
 * empty `hi` (we never guess Devanagari back from Hinglish — that direction is
 * ambiguous and would poison the display value).
 */
export function nameForms(input: string | null | undefined): NameForms {
  const raw = (input ?? "").trim();
  if (!raw) return { hi: "", latin: "", key: "", skeleton: "" };

  if (hasDevanagari(raw)) {
    const hi = normalizeDevanagari(raw);
    const latin = devanagariToLatin(hi);
    return { hi, latin, key: latinToKey(latin), skeleton: latinToSkeleton(latin) };
  }

  const latin = stripLatinHonorifics(raw).toLowerCase().replace(/\s+/g, " ");
  return { hi: "", latin, key: latinToKey(latin), skeleton: latinToSkeleton(latin) };
}

/** What a search box sends to the database. */
export interface QueryForms extends NameForms {
  script: ReturnType<typeof detectScript>;
  raw: string;
}

/** Normalise a user's query the same way stored names were normalised. */
export function queryForms(input: string): QueryForms {
  const raw = input.trim();
  return { ...nameForms(raw), script: detectScript(raw), raw };
}

/**
 * 0..1 similarity between two already-built keys, by trigram overlap (Dice).
 * Postgres does the real ranking server-side with pg_trgm; this mirrors it for
 * client-side previews and for the import-time quality report.
 */
export function similarity(a: string, b: string): number {
  const tri = (s: string) => {
    const p = `  ${s.replace(/\s+/g, " ")} `;
    const set = new Set<string>();
    for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
    return set;
  };
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = tri(a);
  const B = tri(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}
