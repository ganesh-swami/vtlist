#!/usr/bin/env node
/**
 * Voter-roll ingest CLI. Works on one PDF at a time.
 *
 *   pnpm ingest probe   <pdf>   check box detection, write a debug overlay
 *   pnpm ingest sheets  <pdf>   write one legible page image per page, for
 *                               transcribing the names by eye
 *   pnpm ingest headings <pdf>  find every section heading and render it
 *   pnpm ingest zoom    <pdf> <serial...>   blow up single boxes to re-check
 *                               a name that was hard to read
 *   pnpm ingest csv     <pdf>   structure + names -> data/csv/<part>.csv
 *                               (add --no-photos to skip cropping for now)
 *   pnpm ingest migrate         apply supabase/migrations/*.sql (optional)
 *   pnpm ingest load            data/extracted/*.json -> Supabase (optional)
 *
 * Names come from `data/names/<part>.json`, a plain map of
 *   { "<serial>": ["<नाम>", "<पिता/पति का नाम>"] }
 * which is produced either by transcribing the sheets or, with --vision, by
 * calling the API. Everything else on the row is read from the PDF itself.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import {
  boundsOf,
  chunkBoxes,
  cropPhoto,
  cropRegion,
  cropToJpeg,
  debugOverlay,
  deletionReason,
  openPdf,
  readPage,
  renderPage,
} from "./pdf.ts";
import type { PageResult, RawBox } from "./pdf.ts";
import { costSoFar, readNames, usage, type VisionRecord } from "./vision.ts";
import { toCsv } from "./csv.ts";
import { loadPart } from "./db.ts";
import { migrate } from "./migrate.ts";
import type { Elector, ExtractedPart, PartMeta } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PDF_DIR = path.join(ROOT, "data", "pdfs");
const OUT_DIR = path.join(ROOT, "data", "extracted");
const CSV_DIR = path.join(ROOT, "data", "csv");
const NAMES_DIR = path.join(ROOT, "data", "names");
const SHEET_DIR = path.join(ROOT, "data", "sheets");
// Deliberately NOT under apps/web/public: files there are served by Next's
// static handler before any auth code runs. They are streamed instead by
// apps/web/app/api/image, which checks the session first.
const PHOTO_DIR = path.join(ROOT, "data", "images", "photos");
const PAGE_DIR = path.join(ROOT, "data", "images", "pages");
const DEBUG_DIR = path.join(ROOT, "data", "debug");

/** ~290 dpi. Photos are cut from this, so it wants to be generous. */
const SCALE = Number(process.env.RENDER_SCALE ?? 4);

/**
 * Scale for the transcription sheets. 2.2 puts a full 3x9 page grid at roughly
 * 1150x1450 px, which is where the printed Devanagari — matras, anusvaras and
 * all — is unambiguous to read. Verified against the real roll before use.
 */
const SHEET_SCALE = Number(process.env.SHEET_SCALE ?? 2.2);
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY ?? 4);
const BOXES_PER_STRIP = Number(process.env.BOXES_PER_STRIP ?? 5);

const args = process.argv.slice(2);
const command = args[0] ?? "csv";
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const useVision = flags.has("--vision");
// Photos are the slow part (every page has to be rasterised at 4x). Names are
// the deliverable, so cropping can be deferred without blocking anything: the
// filenames are pure functions of the id, so linking them later needs no rerun.
const usePhotos = !flags.has("--no-photos");

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
        `Keep the portal's filename, or rename it like "Ward No-001-Part No-003.pdf".`,
    );
  }
  return { ward, partNo: part };
}

/** One PDF per run — the first positional argument, or the only file present. */
async function pickPdf(): Promise<string> {
  if (positional.length) return path.resolve(positional[0]!);
  const entries = (await readdir(PDF_DIR).catch(() => [])).filter((f) =>
    f.toLowerCase().endsWith(".pdf"),
  );
  if (entries.length === 1) return path.join(PDF_DIR, entries[0]!);
  throw new Error(
    entries.length === 0
      ? `No PDFs in ${path.relative(ROOT, PDF_DIR)}/.`
      : `${entries.length} PDFs present — name the one to process:\n` +
        entries.map((e) => `  pnpm ingest ${command} "data/pdfs/${e}"`).join("\n"),
  );
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

/** Pages that actually hold electors — headers, maps and summaries have none. */
async function contentPages(doc: any): Promise<PageResult[]> {
  const pages: PageResult[] = [];
  for (let p = 1; p <= doc.numPages; p++) pages.push(await readPage(doc, p));
  return pages.filter((pg) => pg.boxes.length > 0);
}

// -------------------------------------------------------------------- sheets

/**
 * Write one image per page for transcription.
 *
 * The page is cropped to the elector grid — headers, ward descriptions and the
 * locality map carry no electors and only cost legibility — and rendered at the
 * scale validated above. The accompanying index says which serials are on each
 * sheet, so a transcription can never drift out of alignment.
 */
async function cmdSheets() {
  const file = await pickPdf();
  const { ward, partNo } = identify(file);
  const partId = `${ward}_${partNo}`;
  const dir = path.join(SHEET_DIR, partId);
  await mkdir(dir, { recursive: true });

  const doc = await openPdf(file);
  const pages = await contentPages(doc);
  console.log(`${path.basename(file)} → ward ${ward}, part ${partNo}`);
  console.log(`  ${pages.length} pages with electors (of ${doc.numPages})`);

  await mkdir(PAGE_DIR, { recursive: true });

  const index: Record<string, number[]> = {};
  await pool(pages, PAGE_CONCURRENCY, async (pg) => {
    const canvas = await renderPage(doc, pg.pageNo, SHEET_SCALE);
    // Reach 40pt above the grid: the section heading for the first box on a
    // page sits outside the boxes, and cropping it away leaves those electors
    // with no locality.
    const grid = boundsOf(pg.boxes, 4);
    const rect = { ...grid, top: Math.max(0, grid.top - 40), height: grid.height + 40 };
    const name = `p${String(pg.pageNo).padStart(3, "0")}.png`;

    // PNG for transcription (lossless, nothing to second-guess) …
    await writeFile(path.join(dir, name), await cropRegion(canvas, rect, SHEET_SCALE, 2400));

    // … and a JPEG of the same crop for the website, which every row on this
    // page points at. One image per page rather than one per elector: ~30x
    // cheaper to produce, and a reader can still zoom to their own क्रम संख्या
    // and check the row against what the roll actually prints.
    const jpeg = await cropToJpeg(canvas, rect, SHEET_SCALE);
    await writeFile(path.join(PAGE_DIR, `${partId}_${name.replace(".png", ".jpg")}`), jpeg);

    index[name] = pg.boxes.map((b) => b.serialNo!).filter((s) => s !== null);
  });

  const ordered = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path.join(dir, "index.json"), JSON.stringify(ordered, null, 2));

  const total = Object.values(ordered).reduce((n, s) => n + s.length, 0);
  console.log(`  → ${path.relative(ROOT, dir)}/  (${pages.length} sheets, ${total} electors)`);
  console.log(`  index.json lists the serials on each sheet.`);
}

// ---------------------------------------------------------------- extraction

type NameMap = Record<string, [string | null, string | null]>;
/**
 * Section headings (street / locality names) are printed in the same broken
 * font as the elector names, so the text layer's version of them is garbage and
 * must never reach the CSV. They are transcribed alongside the names, under a
 * _sections key. It maps the FIRST SERIAL of a section to its heading, because
 * a new heading can start partway down a page (part 3 page 4 starts one at
 * serial 31); every elector from there on belongs to it until the next heading.
 */
type SectionMap = Record<string, string>;

async function loadNameMap(partId: string): Promise<NameMap> {
  const file = path.join(NAMES_DIR, `${partId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as NameMap;
  } catch {
    return {};
  }
}

async function extractOne(file: string): Promise<ExtractedPart> {
  const { ward, partNo } = identify(file);
  const partId = `${ward}_${partNo}`;
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  console.log(`\n${path.basename(file)}  →  ward ${ward}, part ${partNo}`);
  const doc = await openPdf(file);
  const pages = await contentPages(doc);
  const boxCount = pages.reduce((n, pg) => n + pg.boxes.length, 0);
  console.log(`  ${doc.numPages} pages, ${pages.length} with electors, ${boxCount} boxes`);
  if (!boxCount) {
    throw new Error("No elector boxes found — run `pnpm ingest probe` to see why.");
  }

  const raw = await loadNameMap(partId);
  const sections = (raw as any)._sections as SectionMap | undefined;
  const typed: NameMap = Object.fromEntries(
    Object.entries(raw).filter(([k]) => /^\d+$/.test(k)),
  );
  if (Object.keys(typed).length) {
    console.log(`  ${Object.keys(typed).length} transcribed names from data/names/${partId}.json`);
  } else if (!useVision) {
    console.log(`  no data/names/${partId}.json yet — rows will carry no names`);
  }

  await mkdir(PHOTO_DIR, { recursive: true });
  await mkdir(DEBUG_DIR, { recursive: true });

  // Whether a row carries a per-person photo is a fact about the filesystem,
  // not about the flags of this particular run: part 3's crops already exist,
  // and a later --no-photos rebuild must not blank their paths.
  const existingPhotos = new Set(await readdir(PHOTO_DIR).catch(() => []));

  const electors = new Map<number, Elector>();

  await pool(pages, PAGE_CONCURRENCY, async (pg) => {
    const canvas = await renderPage(doc, pg.pageNo, SCALE);

    if (pg.pageNo === pages[0]!.pageNo) {
      await writeFile(
        path.join(DEBUG_DIR, `${partId}-overlay-p${pg.pageNo}.png`),
        await debugOverlay(canvas, pg.boxes, SCALE),
      );
    }

    if (usePhotos) {
      for (const box of pg.boxes) {
        if (box.serialNo === null) continue;
        const id = `${ward}_${partNo}_${box.serialNo}`;
        await writeFile(path.join(PHOTO_DIR, `${id}.jpg`), await cropPhoto(canvas, box.rect, SCALE));
      }
    }

    let seen: VisionRecord[] = [];
    if (useVision) {
      const perChunk = await pool(chunkBoxes(pg.boxes, BOXES_PER_STRIP), 2, async (chunk) => {
        try {
          return await readNames(await cropRegion(canvas, boundsOf(chunk), SCALE), chunk);
        } catch (err) {
          console.warn(`  ! page ${pg.pageNo} strip: ${(err as Error).message}`);
          return [] as VisionRecord[];
        }
      });
      seen = perChunk.flat();
    }
    const byserial = new Map(seen.map((r) => [Number(r.serial), r]));

    for (const box of pg.boxes) {
      if (box.serialNo === null) continue;
      merge(electors, box, typed, byserial.get(box.serialNo), pg, ward, partNo,
        sectionFor(box.serialNo, sections), existingPhotos);
    }

    process.stdout.write(`  page ${pg.pageNo}/${doc.numPages}\r`);
  });
  process.stdout.write("\n");

  const list = [...electors.values()].sort((a, b) => a.serialNo - b.serialNo);
  const named = list.filter((e) => e.name).length;
  console.log(`  ${list.length} electors, ${named} with names, ${list.length - named} still blank`);
  if (useVision) console.log(`  vision: ${usage.calls} calls, ~$${costSoFar().toFixed(2)}`);

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
 * Fold one box into a row.
 *
 * The PDF's own text layer is authoritative for serial, EPIC, age, gender and
 * relation type — those come out of it exactly. Only the two names come from
 * reading the page, because the embedded font mangles them irreversibly.
 * Nothing here is inferred or corrected: a row is what the roll prints.
 */
function merge(
  out: Map<number, Elector>,
  box: RawBox,
  typed: NameMap,
  seen: VisionRecord | undefined,
  pg: PageResult,
  ward: string,
  partNo: string,
  heading: string | null,
  existingPhotos: Set<string>,
) {
  const serial = box.serialNo!;
  const id = `${ward}_${partNo}_${serial}`;
  const prior = out.get(serial);
  const hand = typed[String(serial)];

  const name = hand?.[0] ?? seen?.name ?? prior?.name ?? null;
  const relationName = hand?.[1] ?? seen?.relation_name ?? prior?.relationName ?? null;

  out.set(serial, {
    id,
    serialNo: serial,
    epicNo: box.epicNo ?? prior?.epicNo ?? null,
    name,
    relationName,
    relationType: box.relationType ?? prior?.relationType ?? null,
    houseNo: null, // dropped on request — the roll's house numbers are not wanted
    age: box.age ?? prior?.age ?? null,
    gender: box.gender ?? prior?.gender ?? null,
    sectionLabel: prior?.sectionLabel ?? heading,
    // Supplement additions are the entries printed without an EPIC number.
    listType: box.epicNo ? "main" : "supplement",
    isDeleted: Boolean(box.deletionMark) || Boolean(prior?.isDeleted),
    deletionReason: deletionReason(box.deletionMark) ?? prior?.deletionReason ?? null,
    // Only meaningful once the per-person crop actually exists on disk.
    photoPath: existingPhotos.has(`${id}.jpg`) ? `/api/image/photos/${id}.jpg` : null,
    pageImage: `/api/image/pages/${ward}_${partNo}_p${String(pg.pageNo).padStart(3, "0")}.jpg`,
    pageNo: prior?.pageNo ?? pg.pageNo,
    boxNo: prior?.boxNo ?? box.boxNo,
    raw: { textLayer: { fragments: box.fragments }, vision: seen ?? null },
    confidence: hand ? 1 : seen ? 0.9 : 0,
    needsReview: !name,
  });
}

// ---------------------------------------------------------------- subcommands

async function cmdProbe() {
  const file = await pickPdf();
  const doc = await openPdf(file);
  console.log(`${path.basename(file)} — ${doc.numPages} pages`);
  const pages = await contentPages(doc);
  console.log(`  ${pages.length} pages with electors`);

  for (const pg of pages.slice(0, 2)) {
    console.log(`\n--- page ${pg.pageNo}: ${pg.boxes.length} boxes`);
    for (const b of pg.boxes.slice(0, 3)) {
      console.log(
        `  #${b.serialNo} epic=${b.epicNo} age=${b.age} sex=${b.gender} rel=${b.relationType}` +
          ` del=${b.deletionMark ?? "-"} rect=${b.rect.left.toFixed(0)},${b.rect.top.toFixed(0)}` +
          ` ${b.rect.width.toFixed(0)}x${b.rect.height.toFixed(0)}`,
      );
    }
    await mkdir(DEBUG_DIR, { recursive: true });
    const canvas = await renderPage(doc, pg.pageNo, SCALE);
    const out = path.join(DEBUG_DIR, `probe-p${pg.pageNo}.png`);
    await writeFile(out, await debugOverlay(canvas, pg.boxes, SCALE));
    console.log(`  overlay → ${path.relative(ROOT, out)}`);
  }
  console.log(`\nRed = elector box, blue = photo crop. Nudge PHOTO_* in .env.local if off.`);
}

async function cmdCsv() {
  const file = await pickPdf();
  const result = await extractOne(file);
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(CSV_DIR, { recursive: true });

  const json = path.join(OUT_DIR, `${result.part.id}.json`);
  const csv = path.join(CSV_DIR, `${result.part.id}.csv`);
  await writeFile(json, JSON.stringify(result, null, 2));
  await writeFile(csv, toCsv(result.electors));
  console.log(`  → ${path.relative(ROOT, csv)}`);
  console.log(`  → ${path.relative(ROOT, json)} (provenance; re-runs read this)`);
}

async function cmdLoad() {
  const names = positional.length
    ? positional
    : (await readdir(OUT_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  if (!names.length) {
    console.error("Nothing in data/extracted/. Run `pnpm ingest csv <pdf>` first.");
    process.exitCode = 1;
    return;
  }
  for (const name of names) {
    const file = path.isAbsolute(name) ? name : path.join(OUT_DIR, name);
    const parsed = JSON.parse(await readFile(file, "utf8")) as ExtractedPart;
    console.log(`\n${path.basename(file)}: ${parsed.electors.length} electors`);
    await loadPart(parsed.part, parsed.electors);
  }
}

const commands: Record<string, () => Promise<void>> = {
  probe: cmdProbe,
  zoom: cmdZoom,
  headings: cmdHeadings,
  sheets: cmdSheets,
  csv: cmdCsv,
  migrate: () => migrate(path.join(ROOT, "supabase", "migrations")),
  load: cmdLoad,
};

const run = commands[command];
if (!run) {
  console.error(`Unknown command "${command}". Use: probe | sheets | headings | zoom | csv | migrate | load`);
  process.exit(1);
}
try {
  await run();
} catch (err) {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
}

/**
 * The section heading in force at a given serial: the latest transcribed
 * heading whose starting serial is at or before it. Returns null when the
 * headings for this part have not been transcribed yet — a blank cell is
 * correct, a garbled one never is.
 */
function sectionFor(serial: number, sections: Record<string, string> | undefined): string | null {
  if (!sections) return null;
  let best: string | null = null;
  let bestAt = -1;
  for (const [at, heading] of Object.entries(sections)) {
    const start = Number(at);
    if (Number.isFinite(start) && start <= serial && start > bestAt) {
      bestAt = start;
      best = heading;
    }
  }
  return best;
}

/**
 * Blow up individual elector boxes.
 *
 * A handful of entries on every roll are faded, over-inked or printed over a
 * dark photo, and are genuinely ambiguous at sheet resolution. Rather than
 * guess at a person's name, those serials get re-rendered on their own at ~4x
 * the sheet scale, where the matras resolve.
 */
async function cmdZoom() {
  const file = await pickPdf();
  const wanted = new Set(positional.slice(1).map(Number).filter(Number.isFinite));
  if (!wanted.size) throw new Error("Give the serials to zoom, e.g. `pnpm ingest zoom <pdf> 42 118`");

  const { ward, partNo } = identify(file);
  const dir = path.join(DEBUG_DIR, `zoom-${ward}_${partNo}`);
  await mkdir(dir, { recursive: true });

  const doc = await openPdf(file);
  const cut: Array<{ serial: number; png: Buffer }> = [];
  for (const pg of await contentPages(doc)) {
    const hits = pg.boxes.filter((b) => b.serialNo !== null && wanted.has(b.serialNo));
    if (!hits.length) continue;
    const canvas = await renderPage(doc, pg.pageNo, 9);
    for (const box of hits) {
      // Only the text half of the box — the photo carries no name.
      const png = await cropRegion(canvas, { ...box.rect, width: box.rect.width * 0.7 }, 9, 2000);
      await writeFile(path.join(dir, `${box.serialNo}.png`), png);
      cut.push({ serial: box.serialNo!, png });
      console.log(`  #${box.serialNo} (page ${pg.pageNo})`);
    }
  }
  // Also stack them into one image, so a batch can be re-checked in one look
  // rather than opening a dozen files.
  if (cut.length > 1) {
    cut.sort((a, b) => a.serial - b.serial);
    const imgs = await Promise.all(cut.map((c) => loadImage(c.png)));
    const w = Math.max(...imgs.map((i) => i.width));
    const h = imgs.reduce((n, i) => n + i.height + 8, 0);
    const sheet = createCanvas(w, h);
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "#888888";
    ctx.fillRect(0, 0, w, h);
    let y = 0;
    for (const i of imgs) {
      ctx.drawImage(i, 0, y);
      y += i.height + 8;
    }
    await writeFile(path.join(dir, "strip.png"), await sheet.encode("png"));
    console.log(`  all ${cut.length} stacked → ${path.relative(ROOT, path.join(dir, "strip.png"))}`);
  }
}

/**
 * Find every section heading in a roll and render it for transcription.
 *
 * Headings are printed between rows of boxes, not inside them, so they are easy
 * to miss by eye — and the text layer's copy of them is garbled like every
 * other Devanagari string. They are found here structurally instead: a vertical
 * gap between two box rows that is wider than the page's usual row pitch means
 * a heading was set in between, and the first serial of the row below is where
 * that section begins. Page-top headings are picked up from the leftover text
 * above the first row.
 *
 * Expect false positives: a house number long enough to wrap also pushes the
 * next row down. That is why this renders the strips rather than trusting the
 * geometry — a glance tells a locality name from a wrapped address.
 */
async function cmdHeadings() {
  const file = await pickPdf();
  const { ward, partNo } = identify(file);
  const dir = path.join(DEBUG_DIR, `headings-${ward}_${partNo}`);
  await mkdir(dir, { recursive: true });

  const doc = await openPdf(file);
  const cut: Array<{ serial: number; png: Buffer }> = [];

  for (const pg of await contentPages(doc)) {
    const rows = [...new Set(pg.boxes.map((b) => Math.round(b.rect.top)))].sort((a, b) => a - b);
    const at: number[] = [];

    // A heading above the first row of the page (only when the page opens one).
    if (pg.headings.length) at.push(rows[0]!);
    // Headings between rows.
    if (rows.length > 1) {
      const steps = rows.slice(1).map((v, i) => v - rows[i]!).sort((a, b) => a - b);
      const pitch = steps[Math.floor(steps.length / 2)]!;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i]! - rows[i - 1]! > pitch + 8) at.push(rows[i]!);
      }
    }
    if (!at.length) continue;

    const canvas = await renderPage(doc, pg.pageNo, 3.2);
    const left = Math.min(...pg.boxes.map((b) => b.rect.left));
    const width = Math.max(...pg.boxes.map((b) => b.rect.left + b.rect.width)) - left;

    for (const top of at) {
      const serial = pg.boxes
        .filter((b) => Math.abs(b.rect.top - top) < 3)
        .map((b) => b.serialNo!)
        .sort((a, b) => a - b)[0];
      if (serial === undefined) continue;
      const png = await cropRegion(
        canvas,
        { left, top: Math.max(0, top - 34), width, height: 34 },
        3.2,
        2200,
      );
      await writeFile(path.join(dir, `${serial}.png`), png);
      cut.push({ serial, png });
      console.log(`  heading before serial ${serial} (page ${pg.pageNo})`);
    }
  }

  if (cut.length > 1) {
    cut.sort((a, b) => a.serial - b.serial);
    const imgs = await Promise.all(cut.map((c) => loadImage(c.png)));
    const w = Math.max(...imgs.map((i) => i.width));
    const h = imgs.reduce((n, i) => n + i.height + 6, 0);
    const sheet = createCanvas(w, h);
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "#888888";
    ctx.fillRect(0, 0, w, h);
    let y = 0;
    for (const i of imgs) {
      ctx.drawImage(i, 0, y);
      y += i.height + 6;
    }
    await writeFile(path.join(dir, "all.png"), await sheet.encode("png"));
    console.log(`  ${cut.length} headings → ${path.relative(ROOT, path.join(dir, "all.png"))}`);
  }
  console.log(`  serials: ${JSON.stringify(cut.map((c) => c.serial))}`);
}
