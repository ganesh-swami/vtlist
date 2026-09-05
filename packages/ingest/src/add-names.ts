#!/usr/bin/env node
/**
 * Merge a batch of transcribed names into data/names/<part>.json.
 *
 *   node packages/ingest/src/add-names.ts 1_3 < batch.json
 *
 * The batch is the same shape as the file: serial -> [name, relative's name],
 * plus an optional "_sections" map. Merging rather than rewriting means a
 * transcription can be built up sheet by sheet and resumed at any point, and an
 * entry corrected later simply overwrites the earlier reading.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const partId = process.argv[2];
if (!partId) throw new Error("usage: add-names <partId>   e.g. add-names 1_3");

const file = path.join(ROOT, "data", "names", `${partId}.json`);
const existing: Record<string, unknown> = await readFile(file, "utf8")
  .then((t) => JSON.parse(t))
  .catch(() => ({}));

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const batch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;

const sections = { ...(existing._sections as object), ...(batch._sections as object) };
const merged: Record<string, unknown> = { ...existing, ...batch };
delete merged._sections;

// Numeric keys sorted numerically, so the file reads in roll order.
const ordered: Record<string, unknown> = {};
if (Object.keys(sections).length) ordered._sections = sections;
for (const k of Object.keys(merged).sort((a, b) => Number(a) - Number(b))) ordered[k] = merged[k];

await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(ordered, null, 2) + "\n", "utf8");

const count = Object.keys(ordered).filter((k) => /^\d+$/.test(k)).length;
console.log(`${partId}: +${Object.keys(batch).filter((k) => /^\d+$/.test(k)).length}, now ${count} names`);
