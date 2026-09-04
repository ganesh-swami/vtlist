/**
 * Loading extracted rolls into Supabase.
 *
 * Writes go through the service-role key, which bypasses RLS; the website reads
 * with the publishable key and the read-only policy in the migration.
 */
import { createClient } from "@supabase/supabase-js";
import { nameForms } from "@workspace/normalize";
import type { Elector, PartMeta } from "./types.ts";

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `${key} is not set. Put it in .env.local at the repo root.\n` +
        `The service-role key is in Supabase → Project Settings → API Keys → service_role.`,
    );
  }
  return v;
}

export function db() {
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

/** Turn one extracted elector into the row shape, building all search columns. */
export function toRow(e: Elector, part: PartMeta) {
  const name = nameForms(e.name);
  const rel = nameForms(e.relationName);

  // One field the single search box can match on, so "ramesh 1763" or a
  // father's name alone both find something without extra query branches.
  const blob = [name.hi, name.latin, name.key, rel.hi, rel.latin, rel.key, e.houseNo, e.epicNo]
    .filter(Boolean)
    .join(" ");

  return {
    id: e.id,
    part_id: part.id,
    ward: part.ward,
    part_no: part.partNo,
    serial_no: e.serialNo,
    epic_no: e.epicNo,
    house_no: e.houseNo,
    age: e.age,
    gender: e.gender,
    section_label: e.sectionLabel,
    list_type: e.listType,
    is_deleted: e.isDeleted,
    deletion_reason: e.deletionReason,
    relation_type: e.relationType,
    name_hi: name.hi || null,
    relation_name_hi: rel.hi || null,
    name_latin: name.latin || null,
    relation_name_latin: rel.latin || null,
    name_key: name.key || null,
    relation_name_key: rel.key || null,
    name_skeleton: name.skeleton || null,
    relation_name_skeleton: rel.skeleton || null,
    search_blob: blob,
    photo_path: e.photoPath,
    source_file: part.sourceFile,
    page_no: e.pageNo,
    box_no: e.boxNo,
    raw: e.raw,
    confidence: e.confidence,
    needs_review: e.needsReview,
  };
}

export async function loadPart(part: PartMeta, electors: Elector[]) {
  const supabase = db();

  const { error: partErr } = await supabase.from("voter_parts").upsert({
    id: part.id,
    ward: part.ward,
    part_no: part.partNo,
    body_name: part.bodyName,
    assembly_seat: part.assemblySeat,
    polling_station: part.pollingStation,
    source_file: part.sourceFile,
    file_sha256: part.sha256,
    page_count: part.pageCount,
    elector_count: electors.length,
    extraction_mode: part.extractionMode,
  });
  if (partErr) throw new Error(`voter_parts: ${partErr.message}`);

  const rows = electors.map((e) => toRow(e, part));
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("voters").upsert(slice, { onConflict: "id" });
    if (error) throw new Error(`voters rows ${i}..${i + slice.length}: ${error.message}`);
    process.stdout.write(`    loaded ${Math.min(i + CHUNK, rows.length)}/${rows.length}\r`);
  }
  process.stdout.write("\n");
}
