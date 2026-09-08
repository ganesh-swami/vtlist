/**
 * The localities available to type into an address box.
 *
 * Two sources, because they answer different questions. `addresses` are the
 * ones a canvasser has typed while handing out slips — those only exist for
 * people already delivered to. `sections` are the मोहल्ला headings printed on
 * the roll itself, which every elector has, so searching by one of those
 * reaches voters nobody has visited yet.
 *
 * Returned whole rather than searched: a single ward's list stays small enough
 * to filter in the browser without a round trip per keystroke.
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

  const [saved, sections] = await Promise.all([
    supabase
      .from("addresses")
      .select("id, parent, child")
      .order("parent", { ascending: true })
      .order("child", { ascending: true })
      .returns<AddressRow[]>(),
    supabase
      .from("voter_sections")
      .select("section_label")
      .order("section_label", { ascending: true })
      .returns<{ section_label: string }[]>(),
  ]);

  if (saved.error) {
    return NextResponse.json({ error: saved.error.message, addresses: [] }, { status: 500 });
  }

  return NextResponse.json({
    addresses: saved.data ?? [],
    // A failed sections read is not worth failing the whole box over — the
    // delivery addresses on their own are still useful.
    sections: (sections.data ?? []).map((s) => s.section_label),
  });
}
