#!/usr/bin/env node
/**
 * Voter-roll ingest CLI.
 *
 *   pnpm ingest probe            look at one PDF and write a debug overlay
 *   pnpm ingest extract          PDFs -> data/extracted/*.json + photos
 *   pnpm ingest load             data/extracted/*.json -> Supabase
 *   pnpm ingest all              extract then load, for every PDF
 *
 * Add --no-vision to run the structural pass alone (no API calls, no names) —
 * useful for checking box detection before spending anything.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cropPhoto, debugOverlay, deletionReason, openPdf, readPage, renderPage } from "./pdf.ts";
import type { PageResult, RawBox } from "./pdf.ts";
import { costSoFar, readNames, usage, type VisionRecord } from "./vision.ts";
import { loadPart } from "./db.ts";
import type { Elector, ExtractedPart, PartMeta } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PDF_DIR = path.join(ROOT, "data", "pdfs");
const OUT_DIR = path.join(ROOT, "data", "extracted");
const PHOTO_DIR = path.join(ROOT, "apps", "web", "public", "photos");
const DEBUG_DIR = path.join(ROOT, "data", "debug");

/** 200 dpi: photos land near their printed resolution and pages stay readable. */
const SCALE = Number(process.env.RENDER_SCALE ?? 2.78);
const VISION_CONCURRENCY = Number(process.env.VISION_CONCURRENCY ?? 4);

const args = process.argv.slice(2);
const command = args[0] ?? "all";
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const useVision = !flags.has("--no-vision");

/**
 * Ward and part come from the filename the SEC portal hands out, e.g.
 * "WithPhoto_BIKANER NAGAR NIGAM-Ward No-001-Part No-003.pdf" -> ward 1, part 3.
 * Leading zeros are dropped so ids read as 1_3_57, not 001_003_57.
 */
function identify(file: string): { ward: string; partNo: string } {
  const base = path.basename(file);
  const ward = /ward\s*(?:no\.?)?[-_ ]*0*(\d+)/i.exec(base)?.[1];
  const part = /(?:part|bhag|भाग)\s*(?:no\.?)?[-_ ]*0*(\d+)/i.exec(base)?.[1];
  if (!ward || !part) {
    throw new Error(
      `Cannot read ward/part from "${base}".\n` +
        `Either keep the portal's filename, or rename it like ` +
        `"Ward No-001-Part No-003.pdf".`,
    );
  }
  return { ward, partNo: part };
}

async function listPdfs(): Promise<string[]> {
  if (positional.length) return positional.map((p) => path.resolve(p));
  try {
    const entries = await readdir(PDF_DIR);
    return entries.filter((f) => f.toLowerCase().endsWith(".pdf")).sort().map((f) => path.join(PDF_DIR, f));
  } catch {
    return [];
  }
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, i: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]!, i);
      }
    }),
  );
  return results;
}

// ------------------------------------------------------------------- extract

async function extractOne(file: string): Promise<ExtractedPart> {
  const { ward, partNo } = identify(file);
  const partId = `${ward}_${partNo}`;
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  console.log(`\n${path.basename(file)}  →  ward ${ward}, part ${partNo}`);
  const doc = await openPdf(file);
  console.log(`  ${doc.numPages} pages`);

  await mkdir(PHOTO_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });

  // Pass 1 — structure from the text layer.
  const pages: PageResult[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    pages.push(await readPage(doc, p));
  }
  const boxCount = pages.reduce((n, pg) => n + pg.boxes.length, 0);
  const withSerial = pages.reduce((n, pg) => n + pg.boxes.filter((b) => b.serialNo !== null).length, 0);
  console.log(`  ${boxCount} elector boxes detected, ${withSerial} with a serial number`);

  if (boxCount === 0) {
    throw new Error(
      "No elector boxes found. The नाम label token in pdf.ts probably does not " +
        "match this file's font — run `pnpm ingest probe` to see the raw fragments.",
    );
  }

  // Pass 2 — render, crop photos, and (optionally) read names.
  const carried = new Map<number, string>(); // page -> section heading in force
  let lastHeading: string | null = null;
  const electors = new Map<number, Elector>();

  const pagesWithBoxes = pages.filter((pg) => pg.boxes.length > 0);

  await pool(pagesWithBoxes, VISION_CONCURRENCY, async (pg) => {
    const canvas = await renderPage(doc, pg.pageNo, SCALE);

    if (pg.pageNo === pagesWithBoxes[0]!.pageNo) {
      await writeFile(
        path.join(DEBUG_DIR, `${partId}-overlay-p${pg.pageNo}.png`),
        await debugOverlay(canvas, pg.boxes, SCALE),
      );
    }

    // Photos first — they never depend on the API, so a missing key or a
    // rate limit still leaves a complete set of pictures on disk.
    for (const box of pg.boxes) {
      if (box.serialNo === null) continue;
      const id = `${ward}_${partNo}_${box.serialNo}`;
      await writeFile(path.join(PHOTO_DIR, `${id}.jpg`), await cropPhoto(canvas, box.rect, SCALE));
    }

    let names: VisionRecord[] = [];
    if (useVision) {
      try {
        names = await readNames(await canvas.encode("png"), pg.boxes);
      } catch (err) {
        console.warn(`  ! page ${pg.pageNo}: ${(err as Error).message}`);
      }
    }
    const byserial = new Map(names.map((r) => [Number(r.serial), r]));

    for (const box of pg.boxes) {
      if (box.serialNo === null) continue;
      const seen = byserial.get(box.serialNo);
      merge(electors, box, seen, pg, ward, partNo, lastHeading);
    }
    if (pg.headings.length) lastHeading = pg.headings.join(" ");
    carried.set(pg.pageNo, lastHeading ?? "");
    process.stdout.write(`  page ${pg.pageNo}/${doc.numPages}\r`);
  });
  process.stdout.write("\n");

  const list = [...electors.values()].sort((a, b) => a.serialNo - b.serialNo);
  const flagged = list.filter((e) => e.needsReview).length;
  console.log(`  ${list.length} electors, ${flagged} flagged for review`);
  if (useVision) console.log(`  vision: ${usage.calls} calls, ~$${costSoFar().toFixed(2)} so far`);

  const part: PartMeta = {
    id: partId,
    ward,
    partNo,
    bodyName: "बीकानेर नगर निगम",
    assemblySeat: null,
    pollingStation: null,
    sourceFile: path.basename(file),
    sha256,
    pageCount: doc.numPages,
    extractionMode: useVision ? "text+vision" : "text-layer",
  };
  return { part, electors: list };
}

/**
 * Fold one box's two sources into a row. The text layer wins on serial, EPIC,
 * age, gender and relation type; vision supplies the names and the Hindi text
 * of the house number. Where both have an opinion and disagree, the row is
 * flagged rather than silently resolved.
 */
function merge(
  out: Map<number, Elector>,
  box: RawBox,
  seen: VisionRecord | undefined,
  pg: PageResult,
  ward: string,
  partNo: string,
  heading: string | null,
) {
  const serial = box.serialNo!;
  const id = `${ward}_${partNo}_${serial}`;
  const prior = out.get(serial);

  const disagreements: string[] = [];
  if (seen) {
    if (seen.age != null && box.age != null && seen.age !== box.age) disagreements.push("age");
    if (seen.gender && box.gender && seen.gender !== box.gender) disagreements.push("gender");
    if (seen.relation_type && box.relationType && seen.relation_type !== box.relationType) {
      disagreements.push("relation_type");
    }
  }

  const elector: Elector = {
    id,
    serialNo: serial,
    epicNo: box.epicNo ?? prior?.epicNo ?? null,
    name: seen?.name ?? prior?.name ?? null,
    relationName: seen?.relation_name ?? prior?.relationName ?? null,
    relationType: box.relationType ?? seen?.relation_type ?? prior?.relationType ?? null,
    houseNo: seen?.house_no ?? prior?.houseNo ?? null,
    age: box.age ?? seen?.age ?? prior?.age ?? null,
    gender: box.gender ?? seen?.gender ?? prior?.gender ?? null,
    sectionLabel: prior?.sectionLabel ?? heading,
    // Supplement additions are the entries printed without an EPIC number.
    listType: box.epicNo ? "main" : "supplement",
    // A box may be reprinted in the विलोपन सूची appendix; either printing
    // carrying the marker is enough to mark the person deleted.
    isDeleted: Boolean(box.deletionMark) || Boolean(prior?.isDeleted),
    deletionReason: deletionReason(box.deletionMark) ?? prior?.deletionReason ?? null,
    photoPath: `/photos/${id}.jpg`,
    pageNo: prior?.pageNo ?? pg.pageNo,
    boxNo: prior?.boxNo ?? box.boxNo,
    raw: {
      ...(prior?.raw ?? {}),
      textLayer: {
        serial: box.serialNo,
        epic: box.epicNo,
        age: box.age,
        gender: box.gender,
        relationType: box.relationType,
        deletionMark: box.deletionMark,
        fragments: box.fragments,
      },
      vision: seen ?? null,
      disagreements,
    },
    confidence: seen ? (disagreements.length ? 0.6 : 0.95) : 0.4,
    needsReview: !seen || disagreements.length > 0 || !seen.name,
  };

  out.set(serial, elector);
}

// ---------------------------------------------------------------- subcommands

async function cmdProbe() {
  const files = await listPdfs();
  if (!files.length) return noPdfs();
  const file = files[0]!;
  const doc = await openPdf(file);
  console.log(`${path.basename(file)} — ${doc.numPages} pages`);

  for (const p of [1, 3, doc.numPages].filter((v, i, a) => a.indexOf(v) === i && v <= doc.numPages)) {
    const pg = await readPage(doc, p);
    console.log(`\n--- page ${p}: ${pg.boxes.length} boxes, ${pg.width.toFixed(0)}x${pg.height.toFixed(0)}pt`);
    for (const b of pg.boxes.slice(0, 3)) {
      console.log(
        `  #${b.serialNo} epic=${b.epicNo} age=${b.age} sex=${b.gender} rel=${b.relationType}` +
          ` del=${b.deletionMark ?? "-"} rect=${b.rect.left.toFixed(0)},${b.rect.top.toFixed(0)}` +
          ` ${b.rect.width.toFixed(0)}x${b.rect.height.toFixed(0)}`,
      );
      console.log(`     fragments: ${JSON.stringify(b.fragments)}`);
    }
    if (pg.boxes.length) {
      await mkdir(DEBUG_DIR, { recursive: true });
      const canvas = await renderPage(doc, p, SCALE);
      const out = path.join(DEBUG_DIR, `probe-p${p}.png`);
      await writeFile(out, await debugOverlay(canvas, pg.boxes, SCALE));
      console.log(`  overlay → ${out}`);
    }
  }
  console.log(
    `\nOpen the overlay PNGs. Red = elector box, blue = photo crop.\n` +
      `If they are off, nudge PHOTO_LEFT/TOP/RIGHT/BOTTOM or BOX_HEADER_H in .env.local.`,
  );
}

async function cmdExtract() {
  const files = await listPdfs();
  if (!files.length) return noPdfs();
  await mkdir(OUT_DIR, { recursive: true });
  for (const file of files) {
    const result = await extractOne(file);
    const out = path.join(OUT_DIR, `${result.part.id}.json`);
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(`  → ${path.relative(ROOT, out)}`);
  }
}

async function cmdLoad() {
  const names = positional.length
    ? positional
    : (await readdir(OUT_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  if (!names.length) {
    console.error("Nothing in data/extracted/. Run `pnpm ingest extract` first.");
    process.exitCode = 1;
    return;
  }
  for (const name of names) {
    const file = path.isAbsolute(name) ? name : path.join(OUT_DIR, name);
    const parsed = JSON.parse(await readFile(file, "utf8")) as ExtractedPart;
    console.log(`\n${path.basename(file)}: ${parsed.electors.length} electors`);
    await loadPart(parsed.part, parsed.electors);
  }
  console.log("\nDone.");
}

function noPdfs() {
  console.error(
    `No PDFs found.\n` +
      `Put the roll PDFs in ${path.relative(process.cwd(), PDF_DIR)}/ ` +
      `(keeping the portal filenames), or pass paths as arguments.`,
  );
  process.exitCode = 1;
}

const commands: Record<string, () => Promise<void>> = {
  probe: cmdProbe,
  extract: cmdExtract,
  load: cmdLoad,
  all: async () => {
    await cmdExtract();
    await cmdLoad();
  },
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command "${command}". Use: probe | extract | load | all`);
  process.exit(1);
}
await run();
