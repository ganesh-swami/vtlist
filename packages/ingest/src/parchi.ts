#!/usr/bin/env node
/**
 * Voter parchi (मतदाता पर्ची) — a printable slip per elector, meant to be
 * printed on A4 and cut apart, one per voter.
 *
 *   pnpm ingest parchi 1_1 --sample     one page, first N electors (a preview)
 *   pnpm ingest parchi 1_1              every elector in that part
 *   pnpm ingest parchi 1_1 1_2 1_3 1_4  several parts in one run
 *
 * The slip design itself — layout, fonts, the shrink-to-fit rules — lives in
 * ./parchi-render.ts, shared with the web app's "print selected voters"
 * button (apps/web/app/api/print/route.ts) so both paths produce the same
 * slip. This file is only CSV loading and the CLI.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPdf, PER_PAGE, RELATION_LABEL, SCHOOL_BY_BHAG, type Slip } from "./parchi-render.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CSV_DIR = path.join(ROOT, "data", "csv");
const OUT_DIR = path.join(ROOT, "data", "parchi");

// -------------------------------------------------------------------- data

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

async function loadSlips(partId: string): Promise<Slip[]> {
  const file = path.join(CSV_DIR, `${partId}.csv`);
  const rows = parseCsv(await readFile(file, "utf8"));
  const header = rows[0]!.map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iName = col("naam"), iSambandh = col("sambandh"), iRel = col("sambandhi_naam");
  const iAge = col("aayu"), iBhag = col("bhag"), iKarmank = col("karmank");
  const iEpic = col("epic_no"), iVilopit = col("vilopit");

  return rows.slice(1).map((r) => {
    const bhag = (r[iBhag] ?? "").trim();
    return {
      name: (r[iName] ?? "").trim(),
      relationLabel: RELATION_LABEL[(r[iSambandh] ?? "").trim()] ?? "अभिभावक का नाम",
      relationName: (r[iRel] ?? "").trim(),
      age: (r[iAge] ?? "").trim(),
      bhag,
      karmank: (r[iKarmank] ?? "").trim(),
      epic: (r[iEpic] ?? "").trim(),
      school: SCHOOL_BY_BHAG[bhag] ?? "",
      deleted: Boolean((r[iVilopit] ?? "").trim()),
    };
  });
}

// --------------------------------------------------------------------- cli

const args = process.argv.slice(2);
const sample = args.includes("--sample");
const parts = args.filter((a) => !a.startsWith("--"));
if (!parts.length) {
  throw new Error("usage: pnpm ingest parchi <partId...> [--sample]   e.g. pnpm ingest parchi 1_1 --sample");
}

await mkdir(OUT_DIR, { recursive: true });

for (const partId of parts) {
  const all = await loadSlips(partId);
  const slips = sample ? all.slice(0, PER_PAGE) : all;
  const bytes = await buildPdf(slips);
  const name = sample ? `${partId}-sample.pdf` : `${partId}.pdf`;
  const out = path.join(OUT_DIR, name);
  await writeFile(out, bytes);
  const pages = Math.ceil(slips.length / PER_PAGE);
  console.log(`${partId}: ${slips.length} slip(s), ${pages} page(s), ${PER_PAGE}/page -> ${path.relative(ROOT, out)}`);
}
