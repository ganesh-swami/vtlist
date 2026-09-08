/**
 * Search endpoint.
 *
 * The query is folded here — in the same `@workspace/normalize` code that
 * folded the names at import time — and the folded forms are what reach the
 * database. That is what lets "Rameshwar", "Rameshvar" and रामेश्वर all find
 * the same person — and, since the abbreviation pass, why "Md Hanif" finds
 * "मो॰हनीफ": Postgres only ever compares like with like.
 *
 * The client is built per request from the request's own cookies rather than
 * being a module-level singleton, so every query runs as the signed-in user and
 * row-level security applies. A request with no session gets nothing back from
 * the database even if this route's own check were somehow bypassed.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { nameForms, queryForms } from "@workspace/normalize";
import type { Database, VoterResult } from "@/utils/supabase/types";

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          // Read-only route; the proxy has already refreshed the session.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not signed in", results: [] }, { status: 401 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const relation = (url.searchParams.get("relation") ?? "").trim();
  // EPIC numbers get pasted from all sorts of sources (a PDF, a screenshot's
  // OCR, a messaging app) — strip the invisible characters that habit tends to
  // drag along, so a copy-pasted number is not silently unequal to itself.
  const epic = (url.searchParams.get("epic") ?? "").replace(/[\u200B-\u200D\uFEFF\s]/g, "");
  const gender = url.searchParams.get("gender");
  const part = url.searchParams.get("part");
  const ageMin = url.searchParams.get("age_min");
  const ageMax = url.searchParams.get("age_max");
  const address = (url.searchParams.get("address") ?? "").trim();
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
  const limit = 60;

  if (!q && !relation && !epic && !gender && !part && !ageMin && !ageMax && !address) {
    return NextResponse.json({ results: [], total: 0 });
  }

  // Filtering by address means "whoever was handed a slip here", which lives in
  // `deliveries`, not on the roll — the roll's own section_label is what the
  // printed page says and is a different thing entirely. One address is a
  // street or a household, so this id set stays small.
  let atAddress: string[] | null = null;
  if (address) {
    const { data, error } = await supabase
      .from("deliveries")
      .select("voter_id")
      .eq("address_id", address)
      .returns<{ voter_id: string }[]>();
    if (error) return NextResponse.json({ error: error.message, results: [] }, { status: 500 });
    atAddress = (data ?? []).map((d) => d.voter_id);
    if (!atAddress.length) return NextResponse.json({ results: [], page, hasMore: false });
  }

  // An address on its own is a browse, not a search: return everyone recorded
  // there, in roll order, rather than pushing an empty query through the
  // fuzzy-matching function, which would score every row zero and drop them.
  if (atAddress && !q && !relation && !epic && !gender && !part && !ageMin && !ageMax) {
    const { data, error } = await supabase
      .from("voters")
      .select(
        "id, name_hi, name_latin, relation_type, relation_name_hi, relation_name_latin, house_no, age, gender, epic_no, ward, part_no, serial_no, section_label, is_deleted, photo_path, page_image, page_no",
      )
      .in("id", atAddress)
      .order("part_no", { ascending: true })
      .order("serial_no", { ascending: true })
      .returns<Omit<VoterResult, "score" | "matched_on">[]>();
    if (error) return NextResponse.json({ error: error.message, results: [] }, { status: 500 });
    return NextResponse.json({
      results: (data ?? []).map((v) => ({ ...v, score: 1, matched_on: "address" })),
      page: 0,
      hasMore: false,
    });
  }

  const forms = queryForms(q);

  const { data, error } = await supabase.rpc("search_voters", {
    q_raw: q,
    q_hi: forms.hi,
    q_key: forms.key,
    q_skeleton: forms.skeleton,
    f_relation: relation ? nameForms(relation).key : "",
    f_epic: epic,
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

  // Address combined with a name or another filter narrows what the search
  // found, rather than replacing it.
  const results = atAddress
    ? (data ?? []).filter((v: { id: string }) => atAddress.includes(v.id))
    : (data ?? []);

  return NextResponse.json({
    results,
    page,
    hasMore: (data?.length ?? 0) === limit,
    // Handy when a search surprises someone: it shows what their typing
    // actually got compared against.
    interpreted: { script: forms.script, key: forms.key, devanagari: forms.hi },
  });
}
