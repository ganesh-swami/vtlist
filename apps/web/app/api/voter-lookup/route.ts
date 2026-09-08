/**
 * Finding one voter by the two numbers printed on their पर्ची — भाग संख्या and
 * क्रमांक संख्या. That pair is how a booth worker identifies someone off the
 * printed roll, so the delivery dialog accepts it directly instead of making
 * them search by name first.
 */
import { NextResponse } from "next/server";
import { routeClient } from "@/utils/supabase/route-client";
import type { VoterResult } from "@/utils/supabase/types";

type LookupRow = Pick<
  VoterResult,
  "id" | "name_hi" | "name_latin" | "relation_type" | "relation_name_hi" | "age" | "gender" | "epic_no" | "ward" | "part_no" | "serial_no" | "section_label" | "is_deleted"
>;

const COLUMNS =
  "id, name_hi, name_latin, relation_type, relation_name_hi, age, gender, epic_no, ward, part_no, serial_no, section_label, is_deleted";

export async function GET(request: Request) {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const part = (params.get("part") ?? "").trim();
  const serial = (params.get("serial") ?? "").trim();

  if (!part || !serial) {
    return NextResponse.json({ error: "भाग संख्या और क्रमांक संख्या दोनों चाहिए" }, { status: 400 });
  }
  if (!/^\d+$/.test(serial)) {
    return NextResponse.json({ error: "क्रमांक संख्या केवल अंक में लिखें" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("voters")
    .select(COLUMNS)
    .eq("part_no", part)
    .eq("serial_no", Number(serial))
    .maybeSingle<LookupRow>();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json(
      { error: `भाग ${part} में क्रमांक ${serial} नहीं मिला` },
      { status: 404 },
    );
  }

  return NextResponse.json({ voter: data });
}
