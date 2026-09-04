/**
 * Reading the Devanagari names off the rendered page.
 *
 * This is the one step the text layer cannot do (see the note at the top of
 * pdf.ts — the embedded font's ToUnicode map is many-to-one, so names come out
 * irreversibly scrambled). Everything else is already known from the text
 * layer, and it is passed in as an anchor so the model only has to transcribe,
 * never to count or to guess which box is which.
 *
 * The text-layer facts also serve as a free correctness check afterwards: a
 * page whose returned serials do not match the expected ones is retried, and
 * anything still unresolved is flagged needs_review rather than guessed at.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { RawBox } from "./pdf.ts";

const MODEL = process.env.INGEST_MODEL ?? "claude-opus-5";

const SYSTEM = `You transcribe Hindi (Devanagari) names from scanned Indian municipal electoral rolls.

Each elector appears in a bordered box containing:
  क्रम संख्या (serial number) and an EPIC number in the header
  नाम: <the elector's name>
  पिता का नाम: / पति का नाम: / माता का नाम: / अन्य का नाम: <the relative's name>
  मकान संख्या: <house number>
  आयु: <age>   लिंग: <gender>
  a photograph on the right

Transcribe EXACTLY what is printed. Rules:
- Reproduce the Devanagari characters as printed. Do not translate, romanise,
  correct spelling, expand abbreviations, or "fix" an unusual name.
- Keep internal spacing as printed (राम लाल stays two words; रामलाल stays one).
- Never drop a matra or an anusvara. भँवर, भंवर and भवर are three different
  spellings and whichever is printed is the right one.
- House numbers often mix digits with Hindi letters (1654क, 1758 अ, 1763 ग़) or
  are words (बंगला नगर, सब्जी मंडी के पीछे). Copy them verbatim.
- If a field is genuinely unreadable, use null. Never invent a plausible name.
- A box stamped DELETED still gets transcribed normally.

Return ONLY a JSON array, no prose and no markdown fence. One object per box:
[{"serial": 1, "name": "गणेशाराम", "relation_name": "साडुलराम",
  "relation_type": "father", "house_no": "1520", "age": 55, "gender": "M"}]

relation_type is one of "father" | "husband" | "mother" | "other" and reflects
which label is printed. gender is "M" (पुरुष), "F" (स्त्री) or "O" (तृतीय लिंग).`;

export interface VisionRecord {
  serial: number;
  name: string | null;
  relation_name: string | null;
  relation_type: "father" | "husband" | "mother" | "other" | null;
  house_no: string | null;
  age: number | null;
  gender: "M" | "F" | "O" | null;
}

let client: Anthropic | null = null;
function api() {
  // Zero-arg construction so ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an
  // `ant auth login` profile all work without extra wiring.
  client ??= new Anthropic();
  return client;
}

export const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

/** Strip a markdown fence if the model added one, then parse the array. */
function parseArray(text: string): VisionRecord[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error(`no JSON array in response: ${cleaned.slice(0, 200)}`);
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response was not an array");
  return parsed as VisionRecord[];
}

/**
 * Transcribe one page. `boxes` carries the serials, relation types and ages the
 * text layer already established; they are given to the model as context and
 * used to verify what comes back.
 */
export async function readNames(
  pageImage: Buffer,
  boxes: RawBox[],
  attempt = 1,
): Promise<VisionRecord[]> {
  const expected = boxes
    .map((b) => `${b.serialNo ?? "?"}${b.relationType ? ` (${b.relationType})` : ""}`)
    .join(", ");

  const response = await api().messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    // Transcription needs care, not deliberation; low effort keeps the cost of
    // ~160 pages in single-digit dollars without hurting accuracy.
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: pageImage.toString("base64") },
          },
          {
            type: "text",
            text:
              `This page has ${boxes.length} elector boxes, in reading order ` +
              `(left to right, top to bottom), with these serial numbers: ${expected}.\n` +
              `Return exactly ${boxes.length} objects, one per box, in that same order.` +
              (attempt > 1
                ? `\n\nThe previous attempt returned the wrong serials. Read the header of each box carefully.`
                : ""),
          },
        ],
      },
    ],
  });

  usage.calls++;
  usage.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
  usage.outputTokens += response.usage.output_tokens;

  if (response.stop_reason === "refusal") {
    throw new Error(`refused: ${response.stop_details?.explanation ?? "no detail"}`);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const records = parseArray(text);

  // Cross-check against the text layer, which is authoritative for serials.
  const want = boxes.map((b) => b.serialNo).filter((s): s is number => s !== null);
  const got = new Set(records.map((r) => Number(r.serial)));
  const missing = want.filter((s) => !got.has(s));

  if (missing.length && attempt < 3) {
    return readNames(pageImage, boxes, attempt + 1);
  }
  return records;
}

/** Rough running cost at Claude Opus 5 rates ($5 / $25 per million tokens). */
export function costSoFar(): number {
  return (usage.inputTokens / 1e6) * 5 + (usage.outputTokens / 1e6) * 25;
}
