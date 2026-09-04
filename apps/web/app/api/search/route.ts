/**
 * Search endpoint.
 *
 * The query is folded here — in the same `@workspace/normalize` code that
 * folded the names at import time — and the folded forms are what reach the
 * database. That is what lets "Rameshwar", "Rameshvar" and रामेश्वर all find
 * the same person: Postgres only ever compares like with like.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { nameForms, queryForms } from "@workspace/normalize";

// Built on first request, not at module load, so a missing env var surfaces as
// a 500 with a readable message instead of failing the whole build.
let client: ReturnType<typeof createClient> | null = null;
function supabase() {
  client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } },
  );
  return client;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const relation = (url.searchParams.get("relation") ?? "").trim();
  const gender = url.searchParams.get("gender");
  const part = url.searchParams.get("part");
  const ageMin = url.searchParams.get("age_min");
  const ageMax = url.searchParams.get("age_max");
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
  const limit = 60;

  if (!q && !relation && !gender && !part && !ageMin && !ageMax) {
    return NextResponse.json({ results: [], total: 0 });
  }

  const forms = queryForms(q);

  const { data, error } = await supabase().rpc("search_voters", {
    q_raw: q,
    q_hi: forms.hi,
    q_key: forms.key,
    q_skeleton: forms.skeleton,
    f_relation: relation ? nameForms(relation).key : "",
    f_gender: gender || null,
    f_age_min: ageMin ? Number(ageMin) : null,
    f_age_max: ageMax ? Number(ageMax) : null,
    f_part: part || null,
    lim: limit,
    off: page * limit,
  });

  if (error) {
    return NextResponse.json({ error: error.message, results: [] }, { status: 500 });
  }

  return NextResponse.json({
    results: data ?? [],
    page,
    hasMore: (data?.length ?? 0) === limit,
    // Handy when a search surprises someone: it shows what their typing
    // actually got compared against.
    interpreted: { script: forms.script, key: forms.key, devanagari: forms.hi },
  });
}
