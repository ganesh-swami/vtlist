/**
 * The localities a canvasser has already used, for the delivery dialog's two
 * dropdowns. Returned whole rather than searched: a single ward's list stays
 * small enough that the dialog can filter it in the browser without a round
 * trip per keystroke.
 */
import { NextResponse } from "next/server";
import { routeClient } from "@/utils/supabase/route-client";

export interface AddressRow {
  id: string;
  parent: string;
  child: string;
}

export async function GET() {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in", addresses: [] }, { status: 401 });

  const { data, error } = await supabase
    .from("addresses")
    .select("id, parent, child")
    .order("parent", { ascending: true })
    .order("child", { ascending: true })
    .returns<AddressRow[]>();

  if (error) return NextResponse.json({ error: error.message, addresses: [] }, { status: 500 });
  return NextResponse.json({ addresses: data ?? [] });
}
