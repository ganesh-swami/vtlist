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
import type { Database } from "@/utils/supabase/types";

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
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
  const limit = 60;

  if (!q && !relation && !epic && !gender && !part && !ageMin && !ageMax) {
    return NextResponse.json({ results: [], total: 0 });
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

  return NextResponse.json({
    results: data ?? [],
    page,
    hasMore: (data?.length ?? 0) === limit,
    // Handy when a search surprises someone: it shows what their typing
    // actually got compared against.
    interpreted: { script: forms.script, key: forms.key, devanagari: forms.hi },
  });
}
