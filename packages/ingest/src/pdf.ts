/**
 * Reading a Rajasthan SEC municipal roll PDF.
 *
 * These PDFs carry a text layer, but it is written in a legacy 8-bit Devanagari
 * font whose ToUnicode map is many-to-one: the single character र stands in for
 * र, व AND the ा matra, so "भंवरलाल" comes out as "मनररलरल". That collapse is
 * lossy and cannot be undone by any substitution table — which is why names are
 * read from the rendered page by `vision.ts` instead.
 *
 * What the text layer IS good for is everything that is plain ASCII or a whole
 * fixed token, and all of it comes out perfectly:
 *
 *   serial number, EPIC number, deletion marker   1 / IXQ0584201 / "E"
 *   age                                           digits
 *   the field labels                              stable garbled words
 *   gender and relation type                      stable garbled words
 *   house number, when it is printed as digits    digits
 *   EXACT COORDINATES of every box on the page    <- the important one
 *
 * So this module builds the page's box grid from the text layer, and the crops
 * and the vision pass both hang off that grid. The garbled tokens below are
 * matched as whole literals, never decoded character by character, so the
 * lossiness never touches them.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { readFile } from "node:fs/promises";

// pdfjs ships an ESM legacy build that works in Node once the worker is pointed
// at a real file URL.
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
try {
  pdfjs.GlobalWorkerOptions.workerSrc = import.meta.resolve(
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
  );
} catch {
  // Falls back to pdfjs' in-process fake worker, which is fine for a CLI.
}

// ---------------------------------------------------------------- known tokens

/**
 * Field labels as the broken font renders them. Two fonts are in play: the main
 * roll (pages 1..n) and the पूरक / supplement pages, which encode ी and ं
 * differently — hence the pairs. Everything here is matched with `includes`,
 * so a token only has to be a stable substring, not an exact string.
 */
export const TOKENS = {
  /** पिता — the label word, whole. pdfjs emits each word as its own item. */
  father: ["नपतर"], // नपतर
  /** पति */
  husband: ["पनत"], // पनत
  /** माता */
  mother: ["मरतर"], // मरतर
  /** अन्य */
  other: ["अनज"], // अनज
  /** पुरुष */
  male: ["पचरष"], // पचरष
  /** तृतीय — checked before स्त्री, because both are short. */
  third: ["ततलतज", "तततलज", "ततबतज"], // ततलतज / तततलज
  /** स्त्री — ी differs between the two fonts, so both spellings are listed. */
  female: ["सल", "सब"], // सल / सब
  /** आयु */
  ageLabel: ["आजच"], // आजच
  /** मकान */
  houseLabel: ["मकरन"], // मकरन
} as const;

const is = (s: string, list: readonly string[]) => list.includes(s.trim());

/** EPIC numbers, both the modern and the older RJ/xx/xxx/xxxxxx form. */
const EPIC = /^(?:[A-Z]{3}\d{7}|RJ\/\d{2}\/\d{3}\/\d{6})$/;
/** A serial number, as printed in the roll's dedicated serial font. */
const SERIAL = /^\d{1,5}$/;
/** The deletion marker printed immediately left of a struck-off serial. */
const MARK = /^[ESR]$/;

const DELETION_REASON: Record<string, "death" | "shifted" | "repetition"> = {
  E: "death",
  S: "shifted",
  R: "repetition",
};

// ------------------------------------------------------------------- geometry

/**
 * Where the photo sits inside an elector box, as fractions of the box.
 * Overridable from .env.local so the numbers can be nudged against the debug
 * overlay without touching code.
 */
export const PHOTO = {
  left: num("PHOTO_LEFT", 0.665),
  top: num("PHOTO_TOP", 0.05),
  right: num("PHOTO_RIGHT", 0.985),
  bottom: num("PHOTO_BOTTOM", 0.98),
};
/**
 * Offset from the serial number's baseline origin to the box's top-left corner,
 * in PDF points. Measured on the real roll: the serial sits at x=49,y=160 in a
 * box whose corner is at x=34,y=147.
 */
const SERIAL_OFF_X = num("SERIAL_OFF_X", 15);
/**
 * Extra slack on the LEFT when collecting a box's text, over and above the
 * printed box rectangle. The serial sits ~13pt right of the box edge on the
 * main pages but ~22pt on the supplement pages, so a fixed rectangle clips the
 * first word of each label line there ('पिता', 'मकान', 'आयु') and the row comes
 * out with no relation type or gender. Widening only the text window fixes that
 * without moving the photo crop: the strip this reaches into is the previous
 * column's photo, which contains no text at all.
 */
const TEXT_PAD_LEFT = num("TEXT_PAD_LEFT", 14);
const SERIAL_OFF_Y = num("SERIAL_OFF_Y", 13);

function num(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RawBox {
  /** Serial number printed on the roll — the third part of the row id. */
  serialNo: number | null;
  epicNo: string | null;
  deletionMark: "E" | "S" | "R" | null;
  age: number | null;
  gender: "M" | "F" | "O" | null;
  relationType: "father" | "husband" | "mother" | "other" | null;
  /** Digits-only house number from the text layer; Hindi ones come from the scan. */
  houseNo: string | null;
  pageNo: number;
  boxNo: number;
  /** Box bounds in top-down page points, at scale 1. */
  rect: Rect;
  /** Every text fragment inside the box, garbled — kept for debugging only. */
  fragments: string[];
}

export interface PageResult {
  pageNo: number;
  width: number;
  height: number;
  boxes: RawBox[];
  /** Section heading above the first box, e.g. a street name (still garbled). */
  headings: string[];
}

interface Item {
  str: string;
  x: number;
  top: number;
  width: number;
  height: number;
  /** pdfjs font id — the serial-number anchor is identified by this. */
  font: string;
}

/** Cluster sorted numbers, starting a new group whenever the gap exceeds `gap`. */
function cluster(values: number[], gap: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const v of sorted) {
    const last = groups.at(-1);
    if (last && v - last.at(-1)! <= gap) last.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Open a PDF once; the handle is reused for text, rendering and cropping. */
export async function openPdf(path: string) {
  const data = new Uint8Array(await readFile(path));
  // canvasFactory is honoured at runtime by pdfjs 4.x but is missing from its
  // published DocumentInitParameters type, hence the cast.
  return await pdfjs.getDocument({
    data,
    canvasFactory: new NodeCanvasFactory(),
    isEvalSupported: false,
    useSystemFonts: false,
  } as any).promise;
}

/**
 * Build the elector-box grid for one page.
 *
 * The anchor is the serial number. The roll typesets serial numbers in a font
 * of their own — nothing else on the page uses it — so "every item in the
 * serial font that is a bare integer" is exactly one item per elector box, with
 * no false positives from ages, house numbers or page numbers. The column and
 * row spacing then falls out of those anchors, which matters because section
 * headings push rows down mid-page and the grid is not uniform.
 *
 * Word-level parsing is deliberate too: pdfjs emits each word as its own item,
 * so labels are matched as whole words ("नपतर" = पिता) rather than as
 * substrings of a joined line. The font's ToUnicode map is lossy for names, but
 * it is perfectly stable for these fixed label words.
 */
export async function readPage(doc: any, pageNo: number): Promise<PageResult> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items: Item[] = content.items
    .filter((i: any) => typeof i.str === "string" && i.str.trim() !== "")
    .map((i: any) => ({
      str: i.str.trim(),
      x: i.transform[4],
      top: viewport.height - i.transform[5],
      width: i.width ?? 0,
      height: i.height ?? 10,
      font: i.fontName ?? "",
    }));

  const empty = { pageNo, width: viewport.width, height: viewport.height, boxes: [], headings: [] };

  // Which font is the serial font on this page?
  //
  // "Most numeric items" is not enough — house numbers, ages and EPIC digits all
  // share one font and vastly outnumber the serials. What singles the serials
  // out is that they *count*: read in box order they go 1, 2, 3, … with no gaps.
  // Ages and house numbers never do. Scoring on that also makes the header,
  // summary and deletion-appendix pages fall out on their own, which is right —
  // they carry no new electors, and the deletion marks they repeat are already
  // printed beside the serial in the main list.
  const numeric = new Map<string, Item[]>();
  for (const i of items) {
    if (SERIAL.test(i.str)) (numeric.get(i.font) ?? numeric.set(i.font, []).get(i.font)!).push(i);
  }

  let serialFont = "";
  let best = 0;
  for (const [font, group] of numeric) {
    if (group.length < 3) continue;
    const run = [...group].sort((a, b) => a.top - b.top || a.x - b.x).map((i) => Number(i.str));
    const steps = run.slice(1).filter((v, k) => v - run[k]! === 1).length;
    const consecutive = steps / (run.length - 1);
    if (consecutive >= 0.8 && group.length > best) {
      serialFont = font;
      best = group.length;
    }
  }
  if (!serialFont) return empty;

  const anchors = numeric
    .get(serialFont)!
    .sort((a, b) => a.top - b.top || a.x - b.x);

  const colXs = cluster(anchors.map((a) => a.x), 40);
  const rowTops = cluster(anchors.map((a) => a.top), 12);
  const colStep = colXs.length > 1 ? median(diffs(colXs)) : viewport.width * 0.29;
  const rowStep = rowTops.length > 1 ? median(diffs(rowTops)) : 72.5;

  const boxes: RawBox[] = [];
  const used = new Set<Item>();

  for (const [idx, anchor] of anchors.entries()) {
    const rect: Rect = {
      left: anchor.x - SERIAL_OFF_X,
      top: anchor.top - SERIAL_OFF_Y,
      width: colStep,
      height: rowStep,
    };
    const inside = items.filter(
      (i) =>
        i.x >= rect.left - TEXT_PAD_LEFT &&
        i.x < rect.left + rect.width - 2 &&
        i.top >= rect.top - 2 &&
        i.top < rect.top + rect.height - 2,
    );
    inside.forEach((i) => used.add(i));

    const box: RawBox = {
      serialNo: Number(anchor.str),
      epicNo: null,
      deletionMark: null,
      age: null,
      gender: null,
      relationType: null,
      houseNo: null,
      pageNo,
      boxNo: idx + 1,
      rect,
      fragments: inside.sort((a, b) => a.top - b.top || a.x - b.x).map((i) => i.str),
    };

    // Group the box's items into printed lines, so "the number on the आयु line"
    // is unambiguous even though ages, house numbers and serials all look alike.
    const lines = groupLines(inside);

    for (const line of lines) {
      const words = line.map((i) => i.str);

      for (const item of line) {
        if (!box.epicNo && EPIC.test(item.str)) box.epicNo = item.str;
        if (
          !box.deletionMark &&
          item.font === serialFont &&
          MARK.test(item.str) &&
          item.x < anchor.x
        ) {
          box.deletionMark = item.str as "E" | "S" | "R";
        }
      }

      if (words.some((w) => is(w, TOKENS.ageLabel))) {
        const age = line.find((i) => /^\d{1,3}$/.test(i.str) && i.font !== serialFont);
        if (age) box.age = Number(age.str);
        if (words.some((w) => is(w, TOKENS.male))) box.gender = "M";
        else if (words.some((w) => is(w, TOKENS.third))) box.gender = "O";
        else if (words.some((w) => is(w, TOKENS.female))) box.gender = "F";
      }

      if (!box.relationType) {
        if (words.some((w) => is(w, TOKENS.father))) box.relationType = "father";
        else if (words.some((w) => is(w, TOKENS.husband))) box.relationType = "husband";
        else if (words.some((w) => is(w, TOKENS.mother))) box.relationType = "mother";
        else if (words.some((w) => is(w, TOKENS.other))) box.relationType = "other";
      }

      // House number: whatever follows the मकान संख्या label on its line. Often
      // digits, sometimes Hindi words — the Hindi is garbled here and gets
      // replaced by the transcription, but the digit form is already correct.
      if (!box.houseNo && words.some((w) => is(w, TOKENS.houseLabel))) {
        const after = line.filter((i) => /^[\d\-\s.,/]+$/.test(i.str) && i.str.trim() !== "");
        if (after.length) box.houseNo = after.map((i) => i.str).join("").trim() || null;
      }
    }

    boxes.push(box);
  }

  const firstTop = Math.min(...boxes.map((b) => b.rect.top));
  const headings = items
    .filter((i) => !used.has(i) && i.top > 130 && i.top < firstTop)
    .map((i) => i.str)
    .filter(Boolean);

  return { pageNo, width: viewport.width, height: viewport.height, boxes, headings };
}

/** Split a box's items into printed lines (same baseline within 3pt). */
function groupLines(items: Item[]): Item[][] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.x - b.x);
  const lines: Item[][] = [];
  for (const i of sorted) {
    const last = lines.at(-1);
    if (last && Math.abs(i.top - last[0]!.top) <= 3) last.push(i);
    else lines.push([i]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

function diffs(xs: number[]): number[] {
  return xs.slice(1).map((v, i) => v - xs[i]!);
}

export function deletionReason(mark: string | null) {
  return mark ? (DELETION_REASON[mark] ?? null) : null;
}

// -------------------------------------------------------------------- raster

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: any, width: number, height: number) {
    cc.canvas.width = Math.ceil(width);
    cc.canvas.height = Math.ceil(height);
  }
  destroy(cc: any) {
    cc.canvas.width = 0;
    cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

/** Render one page to a canvas at `scale` (1 = 72dpi, so 2.78 ≈ 200dpi). */
export async function renderPage(doc: any, pageNo: number, scale: number) {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const { canvas, context } = factory.create(viewport.width, viewport.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context as unknown as SKRSContext2D, viewport }).promise;
  return canvas;
}

/** Cut the photo out of one box. Returns JPEG bytes. */
export async function cropPhoto(
  pageCanvas: any,
  rect: Rect,
  scale: number,
): Promise<Buffer> {
  const x = Math.round((rect.left + rect.width * PHOTO.left) * scale);
  const y = Math.round((rect.top + rect.height * PHOTO.top) * scale);
  const w = Math.round(rect.width * (PHOTO.right - PHOTO.left) * scale);
  const h = Math.round(rect.height * (PHOTO.bottom - PHOTO.top) * scale);

  const out = createCanvas(Math.max(w, 1), Math.max(h, 1));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(pageCanvas, x, y, w, h, 0, 0, w, h);
  return await out.encode("jpeg", 82);
}

/**
 * Draw the detected boxes and photo rectangles onto a copy of the page.
 * Run once per PDF and open the PNG: if the outlines sit on the printed boxes,
 * every crop on every page will too.
 */
export async function debugOverlay(pageCanvas: any, boxes: RawBox[], scale: number) {
  const out = createCanvas(pageCanvas.width, pageCanvas.height);
  const ctx = out.getContext("2d");
  ctx.drawImage(pageCanvas, 0, 0);
  ctx.lineWidth = 2;
  for (const b of boxes) {
    ctx.strokeStyle = "rgba(220,0,0,0.85)";
    ctx.strokeRect(b.rect.left * scale, b.rect.top * scale, b.rect.width * scale, b.rect.height * scale);
    ctx.strokeStyle = "rgba(0,120,255,0.9)";
    ctx.strokeRect(
      (b.rect.left + b.rect.width * PHOTO.left) * scale,
      (b.rect.top + b.rect.height * PHOTO.top) * scale,
      b.rect.width * (PHOTO.right - PHOTO.left) * scale,
      b.rect.height * (PHOTO.bottom - PHOTO.top) * scale,
    );
    ctx.fillStyle = "rgba(220,0,0,0.9)";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(String(b.serialNo ?? "?"), b.rect.left * scale + 4, b.rect.top * scale + 16);
  }
  return await out.encode("png");
}

/**
 * Group a page's boxes into the strips that get sent for transcription.
 *
 * Claude downscales any image so neither side exceeds 1568px. A whole A4 page
 * therefore arrives at ~2 px per point, which leaves the 7pt Devanagari names
 * about 13px tall — legible, but thin enough that a matra or an anusvara can be
 * lost. Cutting the page into short vertical runs within one column keeps each
 * strip under the cap at roughly double that scale, so the names arrive at a
 * size where the marks are unambiguous.
 *
 * Grouping is column-major so every group is a contiguous strip, never a
 * scattered set of boxes.
 */
export function chunkBoxes(boxes: RawBox[], perChunk = 5): RawBox[][] {
  const columns = new Map<number, RawBox[]>();
  for (const b of boxes) {
    // Round to the nearest 20pt so slight per-row jitter stays in one column.
    const key = Math.round(b.rect.left / 20);
    (columns.get(key) ?? columns.set(key, []).get(key)!).push(b);
  }
  const chunks: RawBox[][] = [];
  for (const key of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(key)!.sort((a, b) => a.rect.top - b.rect.top);
    for (let i = 0; i < column.length; i += perChunk) {
      chunks.push(column.slice(i, i + perChunk));
    }
  }
  return chunks;
}

/** Bounding rectangle of a group of boxes, with a little breathing room. */
export function boundsOf(boxes: RawBox[], pad = 3): Rect {
  const left = Math.min(...boxes.map((b) => b.rect.left)) - pad;
  const top = Math.min(...boxes.map((b) => b.rect.top)) - pad;
  const right = Math.max(...boxes.map((b) => b.rect.left + b.rect.width)) + pad;
  const bottom = Math.max(...boxes.map((b) => b.rect.top + b.rect.height)) + pad;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Cut an arbitrary region out of the rendered page, downscaling only if it
 * would otherwise exceed `maxEdge` — which is exactly the cap the API applies,
 * so doing it here saves the upload rather than changing what Claude sees.
 */
export async function cropRegion(
  pageCanvas: any,
  rect: Rect,
  scale: number,
  maxEdge = 1560,
): Promise<Buffer> {
  const sx = Math.max(0, Math.round(rect.left * scale));
  const sy = Math.max(0, Math.round(rect.top * scale));
  const sw = Math.min(Math.round(rect.width * scale), pageCanvas.width - sx);
  const sh = Math.min(Math.round(rect.height * scale), pageCanvas.height - sy);

  const shrink = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * shrink));
  const dh = Math.max(1, Math.round(sh * shrink));

  const out = createCanvas(dw, dh);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, dw, dh);
  return await out.encode("png");
}

/** Same crop as `cropRegion`, encoded as JPEG for the website. */
export async function cropToJpeg(
  pageCanvas: any,
  rect: Rect,
  scale: number,
  quality = 84,
): Promise<Buffer> {
  const sx = Math.max(0, Math.round(rect.left * scale));
  const sy = Math.max(0, Math.round(rect.top * scale));
  const sw = Math.min(Math.round(rect.width * scale), pageCanvas.width - sx);
  const sh = Math.min(Math.round(rect.height * scale), pageCanvas.height - sy);

  const out = createCanvas(Math.max(sw, 1), Math.max(sh, 1));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return await out.encode("jpeg", quality);
}
