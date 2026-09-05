/**
 * CSV output — the deliverable.
 *
 * One row per elector, holding exactly what the roll prints and nothing
 * inferred. Values stay in Devanagari (सम्बन्ध is "पिता"/"पति"/"माता"/"अन्य",
 * लिंग is "पुरुष"/"स्त्री"/"तृतीय लिंग") because that is what the page says;
 * the column *headers* are ASCII so Excel, Sheets and psql \copy all behave.
 *
 * Written with a UTF-8 BOM so Excel on Windows opens the Hindi correctly
 * instead of showing mojibake.
 */
import type { Elector } from "./types.ts";

const RELATION_HI: Record<string, string> = {
  father: "पिता",
  husband: "पति",
  mother: "माता",
  other: "अन्य",
};
const GENDER_HI: Record<string, string> = {
  M: "पुरुष",
  F: "स्त्री",
  O: "तृतीय लिंग",
};
const DELETED_HI: Record<string, string> = {
  death: "मृत्यु",
  shifted: "स्थानांतरित",
  repetition: "पुनरावृत्ति",
};

export const COLUMNS = [
  "id",
  "ward",
  "bhag",
  "karmank",
  "epic_no",
  "naam",
  "sambandh",
  "sambandhi_naam",
  "aayu",
  "ling",
  "anubhag",
  "suchi",
  "vilopit",
  "photo",
  "page_image",
  "page",
  "needs_review",
] as const;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote anything containing a delimiter, a quote or a newline; double any
  // embedded quotes. This is the whole of RFC 4180 that matters here.
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(electors: Elector[]): string {
  const rows = electors.map((e) =>
    [
      e.id,
      e.id.split("_")[0],
      e.id.split("_")[1],
      e.serialNo,
      e.epicNo,
      e.name,
      e.relationType ? RELATION_HI[e.relationType] : "",
      e.relationName,
      e.age,
      e.gender ? GENDER_HI[e.gender] : "",
      e.sectionLabel,
      e.listType === "supplement" ? "पूरक" : "मूल",
      e.isDeleted ? (DELETED_HI[e.deletionReason ?? ""] ?? "हाँ") : "",
      e.photoPath,
      e.pageImage,
      e.pageNo,
      e.needsReview ? "1" : "",
    ]
      .map(cell)
      .join(","),
  );
  return "\uFEFF" + [COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}
