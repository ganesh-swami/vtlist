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
 *   the field labels                              fixed garbled strings
 *   gender and relation type                      fixed garbled strings
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
  /** नाम: — one per elector box, and the anchor the whole grid is built on. */
  nameLabel: ["नरम:"], // नरम:
  /** पिता का नाम: */
  father: ["नपतर कर नरम"], // नपतर कर नरम
  /** पति का नाम: */
  husband: ["पनत कर नरम"], // पनत कर नरम
  /** माता का नाम: */
  mother: ["मरतर कर नरम"], // मरतर कर नरम
  /** अन्य का नाम: */
  other: ["अनज कर नरम"], // अनज कर नरम
  /** पुरुष */
  male: ["पचरष"], // पचरष
  /** तृतीय लिंग — checked before स्त्री, because both are short. */
  third: ["ततलतज", "तततलज"], // ततलतज / तततलज
  /** स्त्री — ी differs between the two fonts, so both spellings are listed. */
  female: ["सल", "सब"], // सल / सब
  /** आयु: */
  ageLabel: ["आजच"], // आजच
} as const;

const has = (s: string, list: readonly string[]) => list.some((t) => s.includes(t));

/** Serial + EPIC on the box's header line, e.g. " 1 JGR2375541", "E 57 IXQ0300764". */
const SERIAL_EPIC =
  /^\s*([ESR])?\s*(\d{1,5})\s+([A-Z]{3}\d{7}|RJ\/\d{2}\/\d{3}\/\d{6}|[A-Z]{2,4}[\d/]{6,20})\s*$/;
/** Supplement additions have a serial but no EPIC yet. */
const SERIAL_ONLY = /^\s*([ESR])?\s*(\d{1,5})\s*$/;

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
  left: num("PHOTO_LEFT", 0.72),
  top: num("PHOTO_TOP", 0.06),
  right: num("PHOTO_RIGHT", 0.985),
  bottom: num("PHOTO_BOTTOM", 0.97),
};
/** How far above the नाम label the box's top border sits, in PDF points. */
const HEADER_H = num("BOX_HEADER_H", 15);
const LEFT_PAD = num("BOX_LEFT_PAD", 7);

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
 * Build the elector-box grid for one page from text positions.
 *
 * The grid is derived, not assumed: section headings push rows down mid-page,
 * so column and row positions are measured from the नाम labels themselves and
 * the box size comes from the median spacing between them.
 */
export async function readPage(doc: any, pageNo: number): Promise<PageResult> {
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items: Item[] = content.items
    .filter((i: any) => typeof i.str === "string" && i.str.trim() !== "")
    .map((i: any) => ({
      str: i.str,
      x: i.transform[4],
      top: viewport.height - i.transform[5],
      width: i.width ?? 0,
      height: i.height ?? 10,
    }));

  const anchors = items.filter((i) => has(i.str, TOKENS.nameLabel));
  if (anchors.length === 0) {
    return { pageNo, width: viewport.width, height: viewport.height, boxes: [], headings: [] };
  }

  // Columns and rows, measured rather than assumed.
  const colXs = cluster(anchors.map((a) => a.x), 40);
  const rowTops = cluster(anchors.map((a) => a.top), 12);
  const colStep = colXs.length > 1 ? median(diffs(colXs)) : viewport.width * 0.31;
  const rowStep = rowTops.length > 1 ? median(diffs(rowTops)) : 52;

  const boxes: RawBox[] = [];
  const used = new Set<Item>();

  // Reading order: row by row, left to right — which is also serial order.
  const ordered = [...anchors].sort((a, b) => a.top - b.top || a.x - b.x);

  for (const [idx, anchor] of ordered.entries()) {
    const rect: Rect = {
      left: anchor.x - LEFT_PAD,
      top: anchor.top - HEADER_H,
      width: colStep,
      height: rowStep,
    };
    const inside = items.filter(
      (i) =>
        i.x >= rect.left - 2 &&
        i.x < rect.left + rect.width &&
        i.top >= rect.top - 2 &&
        i.top < rect.top + rect.height,
    );
    inside.forEach((i) => used.add(i));

    const box: RawBox = {
      serialNo: null,
      epicNo: null,
      deletionMark: null,
      age: null,
      gender: null,
      relationType: null,
      pageNo,
      boxNo: idx + 1,
      rect,
      fragments: inside.map((i) => i.str),
    };

    for (const item of inside) {
      const s = item.str;

      const se = SERIAL_EPIC.exec(s);
      if (se && box.serialNo === null) {
        box.deletionMark = (se[1] as "E" | "S" | "R" | undefined) ?? null;
        box.serialNo = Number(se[2]);
        box.epicNo = se[3] ?? null;
        continue;
      }

      // Age and gender share a fragment: "आजच: 55 पचरष".
      if (has(s, TOKENS.ageLabel) || has(s, TOKENS.male) || has(s, TOKENS.female)) {
        const age = /(\d{1,3})/.exec(s);
        if (age && box.age === null) box.age = Number(age[1]);
        if (box.gender === null) {
          if (has(s, TOKENS.male)) box.gender = "M";
          else if (has(s, TOKENS.third)) box.gender = "O";
          else if (has(s, TOKENS.female)) box.gender = "F";
        }
        continue;
      }

      if (box.relationType === null) {
        if (has(s, TOKENS.father)) box.relationType = "father";
        else if (has(s, TOKENS.husband)) box.relationType = "husband";
        else if (has(s, TOKENS.mother)) box.relationType = "mother";
        else if (has(s, TOKENS.other)) box.relationType = "other";
      }
    }

    // Supplement pages print a bare serial with no EPIC; only accept such a
    // fragment once the EPIC form has been ruled out, so ages and house numbers
    // (which are also bare digits) cannot be mistaken for it.
    if (box.serialNo === null) {
      const topOfBox = rect.top + HEADER_H * 0.9;
      for (const item of inside) {
        if (item.top > topOfBox) continue;
        const so = SERIAL_ONLY.exec(item.str);
        if (so) {
          box.deletionMark = (so[1] as "E" | "S" | "R" | undefined) ?? null;
          box.serialNo = Number(so[2]);
          break;
        }
      }
    }

    boxes.push(box);
  }

  // Anything left over above the first box is a section heading (street name).
  const firstTop = Math.min(...boxes.map((b) => b.rect.top));
  const headings = items
    .filter((i) => !used.has(i) && i.top > 90 && i.top < firstTop)
    .map((i) => i.str.trim())
    .filter(Boolean);

  return { pageNo, width: viewport.width, height: viewport.height, boxes, headings };
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
