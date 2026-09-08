/**
 * Recording that a voter has been handed their पर्ची.
 *
 *   GET    ?ids=a,b,c            which of these voters are already marked
 *   POST   { voterId, ... }      mark (or update the details of) one voter
 *   DELETE ?voterId=…            un-mark, for a slip handed out by mistake
 *
 * Only voterId is required. The address, mobile and "कौन लाएगा" are recorded
 * when they happen to be known — a canvasser at a doorstep taps "दे दी" and
 * moves on.
 */
import { NextResponse } from "next/server";
import { routeClient } from "@/utils/supabase/route-client";

export interface DeliveryRow {
  voter_id: string;
  address_id: string | null;
  brought_by: string | null;
  mobile: string | null;
  note: string | null;
  delivered_at: string;
}

const trimmed = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function GET(request: Request) {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in", deliveries: [] }, { status: 401 });

  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) return NextResponse.json({ deliveries: [] });

  const { data, error } = await supabase
    .from("deliveries")
    .select("voter_id, address_id, brought_by, mobile, note, delivered_at")
    .in("voter_id", ids)
    .returns<DeliveryRow[]>();

  if (error) return NextResponse.json({ error: error.message, deliveries: [] }, { status: 500 });
  return NextResponse.json({ deliveries: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const voterId = trimmed(body?.voterId);
  if (!voterId) return NextResponse.json({ error: "voterId is required" }, { status: 400 });

  const parent = trimmed(body?.addressParent);
  const child = trimmed(body?.addressChild) ?? "";

  // A locality the canvasser typed rather than picked becomes a row here, so
  // it is offered in the dropdown from then on. Upsert rather than
  // insert-if-missing: two people adding the same street at once must not race
  // into a duplicate, and the unique index makes the second one a no-op.
  let addressId: string | null = null;
  if (parent) {
    const { data, error } = await supabase
      .from("addresses")
      .upsert({ parent, child }, { onConflict: "parent,child" })
      .select("id")
      .single<{ id: string }>();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    addressId = data?.id ?? null;
  }

  const { error } = await supabase.from("deliveries").upsert(
    {
      voter_id: voterId,
      address_id: addressId,
      brought_by: trimmed(body?.broughtBy),
      mobile: trimmed(body?.mobile),
      note: trimmed(body?.note),
      delivered_at: new Date().toISOString(),
      delivered_by: user.id,
    },
    { onConflict: "voter_id" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, voterId, addressId });
}

export async function DELETE(request: Request) {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const voterId = new URL(request.url).searchParams.get("voterId");
  if (!voterId) return NextResponse.json({ error: "voterId is required" }, { status: 400 });

  const { error } = await supabase.from("deliveries").delete().eq("voter_id", voterId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, voterId });
}
