/**
 * The slice of the database the website actually touches.
 *
 * Hand-written rather than generated, because the site only ever calls one
 * function and never writes. Keep it in step with
 * supabase/migrations/0001_voters.sql.
 */

export interface VoterResult {
  id: string;
  name_hi: string | null;
  name_latin: string | null;
  relation_type: "father" | "husband" | "mother" | "other" | null;
  relation_name_hi: string | null;
  relation_name_latin: string | null;
  house_no: string | null;
  age: number | null;
  gender: "M" | "F" | "O" | null;
  epic_no: string | null;
  ward: string;
  part_no: string;
  serial_no: number;
  section_label: string | null;
  is_deleted: boolean;
  photo_path: string | null;
  page_image: string | null;
  page_no: number;
  score: number;
  matched_on: string;
}

// A `type`, not an `interface`: postgrest-js constrains RPC args to
// Record<string, unknown>, and interfaces get no implicit index signature, so
// an interface here silently collapses the whole rpc() call to `never`.
export type SearchArgs = {
  q_raw: string;
  q_hi: string;
  q_key: string;
  q_skeleton: string;
  f_relation: string;
  f_gender: string | null;
  f_age_min: number | null;
  f_age_max: number | null;
  f_part: string | null;
  lim: number;
  off: number;
}

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      search_voters: {
        Args: SearchArgs;
        Returns: VoterResult[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
