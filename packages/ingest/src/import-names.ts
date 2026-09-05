#!/usr/bin/env node
/**
 * Import names transcribed elsewhere (e.g. by Gemini) into data/names/<part>.json.
 *
 *   node packages/ingest/src/import-names.ts 1_2 path/to/gemini.csv
 *
 * Only three fields are taken from the outside file — serial, name, relative's
 * name. Everything else on the row (EPIC, age, gender, relation type, page,
 * deletion marker, section) is read from the PDF itself and is not up for
 * negotiation, so an outside transcription can only ever be wrong about the two
 * things that genuinely need reading.
 *
 * The serials are checked against the boxes actually found in the PDF, which is
 * what catches the failure that matters: a model skipping or duplicating a box
 * and silently shifting every name after it onto the wrong person.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const partId = process.argv[2];
const csvPath = process.argv[3];
if (!partId || !csvPath) {
  throw new Error("usage: import-names <partId> <file.csv>   e.g. import-names 1_2 gemini.csv");
}

/** Minimal RFC 4180 reader — quotes, embedded commas, CRLF, BOM. */
function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* handled by \n */ }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Find a column by any of several accepted header spellings. */
function findColumn(header: string[], names: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ""));
  for (const n of names) {
    const k = norm.indexOf(n.toLowerCase().replace(/[\s_-]/g, ""));
    if (k !== -1) return k;
  }
  return -1;
}

/** Devanagari digits, in case the transcription kept them. */
function toInt(s: string): number {
  const ascii = s.trim().replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
  const m = /(\d+)/.exec(ascii);
  return m ? Number(m[1]) : NaN;
}

const rows = parseCsv(await readFile(path.resolve(csvPath), "utf8"));
if (rows.length < 2) throw new Error("CSV has no data rows.");

const header = rows[0]!;
const cSerial = findColumn(header, ["karmank", "serial", "serialno", "sno", "क्रमसंख्या", "क्रम"]);
const cName = findColumn(header, ["naam", "name", "नाम", "electorname"]);
const cRel = findColumn(header, [
  "sambandhinaam", "relativename", "relationname", "fathername", "fatherhusbandname",
  "पिता/पतिकानाम", "सम्बन्धीकानाम", "सबंधीनाम",
]);
if (cSerial < 0 || cName < 0 || cRel < 0) {
  throw new Error(
    `Could not find the needed columns in the header:\n  ${header.join(" | ")}\n` +
      `Expected something like: karmank, naam, sambandhi_naam`,
  );
}

// What the PDF itself says should be there.
const indexFile = path.join(ROOT, "data", "sheets", partId, "index.json");
const expected = new Set<number>();
try {
  const idx = JSON.parse(await readFile(indexFile, "utf8")) as Record<string, number[]>;
  for (const list of Object.values(idx)) for (const s of list) expected.add(s);
} catch {
  console.warn(`  (no ${path.relative(ROOT, indexFile)} — skipping the serial cross-check)`);
}

const batch: Record<string, [string | null, string | null]> = {};
const problems: string[] = [];
const seen = new Set<number>();

for (const [i, r] of rows.slice(1).entries()) {
  const serial = toInt(r[cSerial] ?? "");
  if (!Number.isFinite(serial)) {
    problems.push(`row ${i + 2}: unreadable serial ${JSON.stringify(r[cSerial])}`);
    continue;
  }
  if (seen.has(serial)) {
    problems.push(`row ${i + 2}: serial ${serial} appears more than once`);
    continue;
  }
  if (expected.size && !expected.has(serial)) {
    problems.push(`row ${i + 2}: serial ${serial} is not an elector box in the PDF`);
    continue;
  }
  seen.add(serial);
  const name = (r[cName] ?? "").trim();
  const rel = (r[cRel] ?? "").trim();
  if (!/[ऀ-ॿ]/.test(name)) {
    problems.push(`serial ${serial}: name is not Devanagari (${JSON.stringify(name)})`);
  }
  batch[String(serial)] = [name || null, rel || null];
}

const file = path.join(ROOT, "data", "names", `${partId}.json`);
const existing: Record<string, unknown> = await readFile(file, "utf8")
  .then((t) => JSON.parse(t))
  .catch(() => ({}));

const sections = { ...(existing._sections as object) };
const merged: Record<string, unknown> = { ...existing, ...batch };
delete merged._sections;

const ordered: Record<string, unknown> = {};
if (Object.keys(sections).length) ordered._sections = sections;
for (const k of Object.keys(merged).sort((a, b) => Number(a) - Number(b))) ordered[k] = merged[k];
await writeFile(file, JSON.stringify(ordered, null, 2) + "\n", "utf8");

const missing = [...expected].filter((s) => !seen.has(s)).sort((a, b) => a - b);
console.log(`${partId}: imported ${seen.size} names → ${path.relative(ROOT, file)}`);
if (expected.size) {
  console.log(`  PDF has ${expected.size} elector boxes; ${missing.length} still without a name`);
  if (missing.length) {
    const show = missing.slice(0, 40).join(", ");
    console.log(`  missing serials: ${show}${missing.length > 40 ? ` … (+${missing.length - 40})` : ""}`);
  }
}
if (problems.length) {
  console.log(`\n  ${problems.length} problem row(s):`);
  for (const p of problems.slice(0, 25)) console.log(`    ${p}`);
  if (problems.length > 25) console.log(`    … (+${problems.length - 25} more)`);
}
