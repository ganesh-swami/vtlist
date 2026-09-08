/**
 * "Print selected voters" — turns a set of voter ids into the same मतदाता
 * पर्ची PDF the bulk CLI produces (packages/ingest/src/parchi-render.ts is
 * the shared design), sized to just the voters the user checked instead of
 * an entire भाग.
 *
 * Runs as a real Node function (not the edge runtime): the renderer draws
 * through @napi-rs/canvas, a native binary, which the edge runtime can't load.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildPdf, RELATION_LABEL, SCHOOL_BY_BHAG, type Slip } from "@workspace/ingest/parchi-render";

export const runtime = "nodejs";

/** The roll's relation_type enum -> the full label a slip prints. */
const RELATION_BY_TYPE: Record<string, string> = {
  father: RELATION_LABEL["पिता"]!,
  husband: RELATION_LABEL["पति"]!,
  mother: RELATION_LABEL["माता"]!,
  other: RELATION_LABEL["अन्य"]!,
};

interface VoterRow {
  name_hi: string | null;
  relation_type: "father" | "husband" | "mother" | "other" | null;
  relation_name_hi: string | null;
  age: number | null;
  part_no: string;
  serial_no: number;
  epic_no: string | null;
  is_deleted: boolean;
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
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
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
  if (!ids.length) {
    return NextResponse.json({ error: "no voters selected" }, { status: 400 });
  }
  // A print run this large is almost certainly a mistake (a bulk भाग-wide
  // run belongs to the CLI, which streams to disk instead of one response).
  if (ids.length > 500) {
    return NextResponse.json({ error: "too many voters selected (max 500)" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("voters")
    .select("name_hi, relation_type, relation_name_hi, age, part_no, serial_no, epic_no, is_deleted")
    .in("id", ids)
    .order("part_no", { ascending: true })
    .order("serial_no", { ascending: true })
    .returns<VoterRow[]>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) {
    return NextResponse.json({ error: "none of the selected voters were found" }, { status: 404 });
  }

  const slips: Slip[] = data.map((v) => ({
    name: v.name_hi ?? "",
    relationLabel: RELATION_BY_TYPE[v.relation_type ?? "other"] ?? RELATION_LABEL["अन्य"]!,
    relationName: v.relation_name_hi ?? "",
    age: v.age != null ? String(v.age) : "",
    bhag: v.part_no,
    karmank: String(v.serial_no),
    epic: v.epic_no ?? "",
    school: SCHOOL_BY_BHAG[v.part_no] ?? "",
    deleted: v.is_deleted,
  }));

  const bytes = await buildPdf(slips);

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="voter-parchi-${slips.length}.pdf"`,
    },
  });
}
