/**
 * Devanagari -> readable Latin ("Hinglish") transliteration.
 *
 * This is deliberately NOT a scholarly romanisation (no diacritics, no
 * long/short vowel marks). The goal is to produce the spelling an ordinary
 * Hindi speaker would type on a QWERTY keyboard, because that is what we have
 * to match against. रामेश्वर -> "rameshvar", शर्मा -> "sharma", सिंह -> "sinh".
 *
 * The lossy fuzzy key is derived from this Latin form by `latinToKey`, so
 * Devanagari input and typed Hinglish input always meet in the same space.
 */

/** Independent vowels (अ आ इ ...). */
const VOWELS: Record<string, string> = {
  "\u0904": "e", // ऄ
  "\u0905": "a", // अ
  "\u0906": "aa", // आ
  "\u0907": "i", // इ
  "\u0908": "ee", // ई
  "\u0909": "u", // उ
  "\u090A": "oo", // ऊ
  "\u090B": "ri", // ऋ
  "\u090C": "li", // ऌ
  "\u090D": "e", // ऍ
  "\u090E": "e", // ऎ
  "\u090F": "e", // ए
  "\u0910": "ai", // ऐ
  "\u0911": "o", // ऑ
  "\u0912": "o", // ऒ
  "\u0913": "o", // ओ
  "\u0914": "au", // औ
  "\u0960": "ri", // ॠ
  "\u0961": "li", // ॡ
};

/** Dependent vowel signs / matras (ा ि ी ...). */
const MATRAS: Record<string, string> = {
  "\u093A": "e", // ऺ
  "\u093B": "aa", // ऻ
  "\u093E": "aa", // ा
  "\u093F": "i", // ि
  "\u0940": "ee", // ी
  "\u0941": "u", // ु
  "\u0942": "oo", // ू
  "\u0943": "ri", // ृ
  "\u0944": "ri", // ॄ
  "\u0945": "e", // ॅ
  "\u0946": "e", // ॆ
  "\u0947": "e", // े
  "\u0948": "ai", // ै
  "\u0949": "o", // ॉ
  "\u094A": "o", // ॊ
  "\u094B": "o", // ो
  "\u094C": "au", // ौ
  "\u094F": "aw", // ॏ
  "\u0962": "li", // ॢ
  "\u0963": "li", // ॣ
};

/** Consonants. Nukta forms are folded to their base sound. */
const CONSONANTS: Record<string, string> = {
  "\u0915": "k", // क
  "\u0916": "kh", // ख
  "\u0917": "g", // ग
  "\u0918": "gh", // घ
  "\u0919": "n", // ङ
  "\u091A": "ch", // च
  "\u091B": "chh", // छ
  "\u091C": "j", // ज
  "\u091D": "jh", // झ
  "\u091E": "n", // ञ
  "\u091F": "t", // ट
  "\u0920": "th", // ठ
  "\u0921": "d", // ड
  "\u0922": "dh", // ढ
  "\u0923": "n", // ण
  "\u0924": "t", // त
  "\u0925": "th", // थ
  "\u0926": "d", // द
  "\u0927": "dh", // ध
  "\u0928": "n", // न
  "\u0929": "n", // ऩ
  "\u092A": "p", // प
  "\u092B": "ph", // फ
  "\u092C": "b", // ब
  "\u092D": "bh", // भ
  "\u092E": "m", // म
  "\u092F": "y", // य
  "\u0930": "r", // र
  "\u0931": "r", // ऱ
  "\u0932": "l", // ल
  "\u0933": "l", // ळ
  "\u0934": "l", // ऴ
  "\u0935": "v", // व
  "\u0936": "sh", // श
  "\u0937": "sh", // ष
  "\u0938": "s", // स
  "\u0939": "h", // ह
  "\u0958": "k", // क़
  "\u0959": "kh", // ख़
  "\u095A": "g", // ग़
  "\u095B": "z", // ज़
  "\u095C": "d", // ड़
  "\u095D": "dh", // ढ़
  "\u095E": "f", // फ़
  "\u095F": "y", // य़
  "\u0979": "z", // ॹ
  "\u097A": "y", // ॺ
};

const VIRAMA = "\u094D"; // ्
const NUKTA = "\u093C"; // ़
const ANUSVARA = "\u0902"; // ं
const CHANDRABINDU = "\u0901"; // ँ
const VISARGA = "\u0903"; // ः
const ZWJ = "\u200D";
const ZWNJ = "\u200C";

const DEV_DIGITS = "\u0966\u0967\u0968\u0969\u096A\u096B\u096C\u096D\u096E\u096F"; // ०-९

/** Honorifics that appear in front of names on the roll and carry no identity. */
const LEADING_HONORIFICS = [
  "\u0936\u094D\u0930\u0940\u092E\u0924\u0940", // श्रीमती
  "\u0936\u094D\u0930\u0940", // श्री
  "\u0921\u0949\u0915\u094D\u091F\u0930", // डॉक्टर
  "\u0921\u0949", // डॉ
  "\u0938\u094D\u0935\u0930\u094D\u0917\u0940\u092F", // स्वर्गीय
  "\u0938\u094D\u0935\u0964", // स्व।
];

/** True if the string contains any Devanagari code point. */
export function hasDevanagari(s: string): boolean {
  return /[\u0900-\u097F]/.test(s);
}

/** "devanagari" | "latin" | "mixed" | "unknown" — used to pick a match strategy. */
export function detectScript(s: string): "devanagari" | "latin" | "mixed" | "unknown" {
  const dev = /[\u0900-\u097F]/.test(s);
  const lat = /[A-Za-z]/.test(s);
  if (dev && lat) return "mixed";
  if (dev) return "devanagari";
  if (lat) return "latin";
  return "unknown";
}

/**
 * Clean up a Devanagari string without changing what it says:
 * NFC, drop invisible joiners, fold nukta, strip honorifics and punctuation,
 * convert Devanagari digits, collapse whitespace.
 */
export function normalizeDevanagari(input: string): string {
  let s = input.normalize("NFC");
  s = s.replaceAll(ZWJ, "").replaceAll(ZWNJ, "");

  // Decompose the precomposed nukta letters, then drop any standalone nukta,
  // so क़ and क+़ both end up as plain क.
  s = s.normalize("NFD").replaceAll(NUKTA, "").normalize("NFC");

  // Devanagari digits -> ASCII digits.
  s = s.replace(/[\u0966-\u096F]/g, (d) => String(DEV_DIGITS.indexOf(d)));

  // Strip only what is genuinely noise in a name field. The abbreviation sign
  // (\u0970), the full stop and the slash are deliberately KEPT: this roll prints
  // "\u092E\u094B\u0970\u0939\u0928\u0940\u092B", "\u092E\u094B.\u0907\u0915\u092C\u093E\u0932" and "\u090F\u0938/\u0913 \u0924\u093F\u0932\u094B\u0915\u091A\u0902\u0926", and the display value has to
  // reproduce the page. They are handled on the way to the search key instead,
  // where `expandDevanagariAbbreviations` splits and expands them.
  s = s.replace(/[\u0964\u0965\u093D\u0971,;:'"`~!?()\[\]{}\|_*#@^&+=<>]/g, " ");

  s = s.replace(/\s+/g, " ").trim();

  for (const h of LEADING_HONORIFICS) {
    const bare = h.replace(/[\u0964\u0965]/g, "");
    if (s.startsWith(bare + " ")) {
      s = s.slice(bare.length + 1).trim();
      break;
    }
  }
  return s;
}

/**
 * Transliterate Devanagari to readable Latin.
 *
 * Walks the string one code point at a time carrying a "schwa owed" flag: a
 * bare consonant implies a following short 'a' unless a matra or virama
 * cancels it. The word-final schwa is dropped, the way Hindi actually
 * pronounces it (राम -> "ram", not "rama").
 */
export function devanagariToLatin(input: string): string {
  const s = normalizeDevanagari(input)
    // ज्ञ is pronounced "gy" in Hindi, not "jn".
    .replaceAll("\u091C" + VIRAMA + "\u091E", "\u0917" + VIRAMA + "\u092F");

  const words = s.split(" ").filter(Boolean);
  const out: string[] = [];

  for (const word of words) {
    let buf = "";
    let schwaOwed = false;

    const flush = () => {
      if (schwaOwed) {
        buf += "a";
        schwaOwed = false;
      }
    };

    for (const ch of word) {
      const cons = CONSONANTS[ch];
      if (cons !== undefined) {
        flush();
        buf += cons;
        schwaOwed = true;
        continue;
      }
      const matra = MATRAS[ch];
      if (matra !== undefined) {
        schwaOwed = false; // the matra replaces the inherent vowel
        buf += matra;
        continue;
      }
      const vowel = VOWELS[ch];
      if (vowel !== undefined) {
        flush();
        buf += vowel;
        continue;
      }
      if (ch === VIRAMA) {
        schwaOwed = false; // halant kills the inherent vowel
        continue;
      }
      if (ch === ANUSVARA || ch === CHANDRABINDU) {
        flush();
        buf += "n";
        continue;
      }
      if (ch === VISARGA) {
        flush();
        buf += "h";
        continue;
      }
      if (/[0-9A-Za-z]/.test(ch)) {
        flush();
        buf += ch.toLowerCase();
        continue;
      }
      // Anything else (stray combining marks, unknown symbols) is dropped.
    }

    // Word-final inherent 'a' is not pronounced.
    if (schwaOwed && buf.length > 1) schwaOwed = false;
    flush();

    if (buf) out.push(buf);
  }

  return out.join(" ");
}
