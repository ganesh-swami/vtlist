/**
 * The parchi (मतदाता पर्ची) rendering engine — turns a list of voters into the
 * printable-slip PDF, shared between the bulk CLI (parchi.ts, one PDF per
 * भाग) and the web app's "print selected voters" feature (one PDF for
 * whatever the user checked). Both must produce the identical slip design, so
 * the design lives here once rather than in either caller.
 *
 * WHY THIS IS RENDERED, NOT TYPESET AS PDF TEXT
 * ----------------------------------------------
 * A PDF library like pdf-lib can embed a Devanagari font, but embedding is not
 * shaping: it can only place one glyph per code point in the order the string
 * was written. Hindi text needs a shaping engine to reorder matras before
 * their consonant and to fuse conjuncts (क् + ष -> क्ष) into one glyph — pdf-lib
 * has no such engine, and text drawn through it comes out with matras in the
 * wrong place and conjuncts left broken apart.
 *
 * @napi-rs/canvas draws through the operating system's own text stack, which
 * already does this shaping correctly (checked against Windows' bundled
 * "Nirmala UI" font before writing this — every conjunct and matra in a test
 * string came out correctly formed). So each output page is composed as one
 * full-resolution raster image and that single image is embedded as the
 * entire content of one PDF page. The PDF is only a container here; nothing
 * in it is native PDF text.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

/** भाग संख्या -> मतदान केंद्र (polling-booth / school name). */
export const SCHOOL_BY_BHAG: Record<string, string> = {
  "1": "सब्लाइम पब्लिक स्कूल",
  "2": "सब्लाइम पब्लिक स्कूल",
  // Confirmed NOT "संस्कृत" (Sanskrit) — "san" transliterated plainly instead.
  // If the school's own signboard spells this differently, fix it here.
  "3": "श्री सन शिक्षा सदन",
  "4": "श्री सन शिक्षा सदन",
};

/** The roll's short relation word -> the full label a slip prints. */
export const RELATION_LABEL: Record<string, string> = {
  पिता: "पिता का नाम",
  पति: "पति का नाम",
  माता: "माता का नाम",
  अन्य: "अभिभावक का नाम",
};

// ------------------------------------------------------------------ layout
//
// A4 at 300dpi = 2481 x 3507px. Two columns of full-height slips, 7 rows —
// 14 voters a page. The gutter between columns is wide on purpose: it is the
// margin a scissors needs either side of the cut, so a slightly wobbly cut
// down the middle never nicks into either voter's text.

const PAGE_W = 2481;
const PAGE_H = 3507;
const MARGIN = 50;
const ROW_GUTTER = 8;
const COL_GUTTER = 60;
const COLS = 2;
const SLIP_W = (PAGE_W - 2 * MARGIN - COL_GUTTER) / COLS;
const SLIP_H = 479;
const ROWS = Math.floor((PAGE_H - 2 * MARGIN + ROW_GUTTER) / (SLIP_H + ROW_GUTTER));
export const PER_PAGE = COLS * ROWS;
/** Left inner margin before any text starts — clear of the cut line. */
const PAD = 51;

const FONT = "Nirmala UI";
// Black-and-white only, deliberately — thousands of these get run off on a
// shared office photocopier, not a colour printer, and a design that depends
// on colour to read correctly turns to mush the moment it's copied on one.
// Every fill below is black, white, or a grey.
const INK = "#000000";
const MUTED = "#4d4d4d";

export interface Slip {
  name: string;
  relationLabel: string;
  relationName: string;
  age: string;
  bhag: string;
  karmank: string;
  epic: string;
  school: string;
  deleted: boolean;
}

// -------------------------------------------------------------- one slip

/** Draw "label: value" starting at x, and return the x just past it. */
function inline(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  label: string,
  value: string,
  labelSize: number,
  valueSize: number,
  valueBold: boolean,
): number {
  ctx.font = `${labelSize}px "${FONT}"`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`${label}: `, x, y);
  const labelW = ctx.measureText(`${label}: `).width;

  ctx.font = `${valueBold ? "bold " : ""}${valueSize}px "${FONT}"`;
  ctx.fillStyle = INK;
  const text = value || "—";
  ctx.fillText(text, x + labelW, y);
  const valueW = ctx.measureText(text).width;

  return x + labelW + valueW;
}

interface Segment {
  label: string;
  value: string;
  labelSize: number;
  valueSize: number;
  /** Most values are bold to stand out from their label; आयु reads fine unbolded. */
  valueBold?: boolean;
}

/** Width a row of "label: value" segments would take at their given sizes. */
function measureRow(ctx: SKRSContext2D, segments: Segment[], gap: number): number {
  let total = 0;
  segments.forEach((seg, i) => {
    ctx.font = `${seg.labelSize}px "${FONT}"`;
    total += ctx.measureText(`${seg.label}: `).width;
    ctx.font = `${seg.valueBold === false ? "" : "bold "}${seg.valueSize}px "${FONT}"`;
    total += ctx.measureText(seg.value || "—").width;
    if (i < segments.length - 1) total += gap;
  });
  return total;
}

/**
 * Draw a row of "label: value" segments, shrinking every font size in the row
 * by the same ratio if — and only if — they would not fit in maxWidth.
 *
 * A handful of names on this roll are long enough on their own to run past a
 * fixed-size line no matter how generously it's sized (measured against all
 * 4,024 rows before this was added: ~50 of them would have overflowed a
 * static layout). Shrinking only when needed means the other ~99% of rows
 * print at full, comfortable size, and the rare long name is still fully
 * readable, just a little smaller — never cut off or run into the cut line.
 */
function drawRow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  segments: Segment[],
  gap: number,
  maxWidth: number,
) {
  const natural = measureRow(ctx, segments, gap);
  const scale = natural > maxWidth ? maxWidth / natural : 1;
  let cx = x;
  segments.forEach((seg, i) => {
    const labelSize = scale === 1 ? seg.labelSize : Math.max(14, Math.round(seg.labelSize * scale));
    const valueSize = scale === 1 ? seg.valueSize : Math.max(16, Math.round(seg.valueSize * scale));
    cx = inline(ctx, cx, y, seg.label, seg.value, labelSize, valueSize, seg.valueBold !== false);
    if (i < segments.length - 1) cx += scale === 1 ? gap : Math.round(gap * scale);
  });
}

function drawSlip(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  s: Slip,
  isLeftCol: boolean,
) {
  ctx.save();
  ctx.translate(x, y);

  // No header, no party mark, no candidate line — three tight data rows
  // instead of two, so no line is left carrying empty width, and every
  // field can be set in a noticeably bigger font than before. आयु moved off
  // the name line and onto the क्रमांक/भाग line, freeing the name line down
  // to just two fields (so both can run larger).
  ctx.textBaseline = "alphabetic";
  let cy = s.deleted ? 108 : 138;

  if (s.deleted) {
    ctx.font = `bold 40px "${FONT}"`;
    ctx.fillStyle = INK;
    ctx.fillText("(विलोपित)", PAD, cy);
    cy += 56;
  }

  const rowLimit = SLIP_W - PAD - 24; // clear of the physical cut edge

  drawRow(ctx, PAD, cy, [
    { label: "नाम", value: s.name, labelSize: 44, valueSize: 54 },
    { label: s.relationLabel, value: s.relationName, labelSize: 44, valueSize: 50 },
  ], 90, rowLimit);
  cy += 130;

  // क्रमांक संख्या (serial number) is deliberately the largest, boldest thing
  // on this line, and comes first — it's what a booth worker actually reads
  // off this slip to find the voter on the printed roll, so it has to be
  // legible at a glance. आयु sits between it and भाग, its value left
  // unbolded since it's a minor reference detail, not something looked up.
  drawRow(ctx, PAD, cy, [
    { label: "क्रमांक सं.", value: s.karmank, labelSize: 44, valueSize: 60 },
    { label: "आयु", value: s.age, labelSize: 38, valueSize: 42, valueBold: false },
    { label: "भाग सं.", value: s.bhag, labelSize: 36, valueSize: 48 },
  ], 55, rowLimit);
  cy += 130;

  drawRow(ctx, PAD, cy, [
    { label: "EPIC", value: s.epic, labelSize: 34, valueSize: 36 },
    { label: "केंद्र", value: s.school, labelSize: 34, valueSize: 36 },
  ], 60, rowLimit);

  // Horizontal cut between one row and the next.
  ctx.strokeStyle = "#999999";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(0, SLIP_H);
  ctx.lineTo(SLIP_W, SLIP_H);
  ctx.stroke();

  // Vertical cut between the two columns — drawn once, in the middle of the
  // gutter, by the left-hand slip only, so it isn't drawn twice.
  if (isLeftCol) {
    ctx.beginPath();
    ctx.moveTo(SLIP_W + COL_GUTTER / 2, 0);
    ctx.lineTo(SLIP_W + COL_GUTTER / 2, SLIP_H);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.font = `31px "${FONT}"`;
  ctx.fillStyle = "#999999";
  if (isLeftCol) ctx.fillText("✂", -6, SLIP_H + 10); // left page edge only

  ctx.restore();
}

// ------------------------------------------------------------------ pages

async function renderPage(slips: Slip[]): Promise<Buffer> {
  const canvas = createCanvas(PAGE_W, PAGE_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  slips.forEach((s, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = MARGIN + col * (SLIP_W + COL_GUTTER);
    const y = MARGIN + row * (SLIP_H + ROW_GUTTER);
    drawSlip(ctx, x, y, s, col === 0);
  });

  return canvas.encode("png");
}

export async function buildPdf(slips: Slip[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < slips.length; i += PER_PAGE) {
    const chunk = slips.slice(i, i + PER_PAGE);
    const png = await renderPage(chunk);
    const image = await doc.embedPng(png);
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  }
  return doc.save();
}
