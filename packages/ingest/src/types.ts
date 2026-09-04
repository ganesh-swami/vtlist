/** Shapes shared between extraction, the on-disk JSON, and the database load. */

export interface PartMeta {
  /** '{ward}_{part}', e.g. '1_3'. */
  id: string;
  ward: string;
  partNo: string;
  bodyName: string | null;
  assemblySeat: string | null;
  pollingStation: string | null;
  sourceFile: string;
  sha256: string;
  pageCount: number;
  extractionMode: "text-layer" | "text+vision";
}

export interface Elector {
  /** '{ward}_{part}_{serial}', e.g. '1_3_923'. Also the photo filename. */
  id: string;
  serialNo: number;
  epicNo: string | null;
  name: string | null;
  relationName: string | null;
  relationType: "father" | "husband" | "mother" | "other" | null;
  houseNo: string | null;
  age: number | null;
  gender: "M" | "F" | "O" | null;
  sectionLabel: string | null;
  listType: "main" | "supplement";
  isDeleted: boolean;
  deletionReason: "death" | "shifted" | "repetition" | null;
  photoPath: string | null;
  pageNo: number;
  boxNo: number;
  /** Everything both passes saw, so any row can be audited without the PDF. */
  raw: Record<string, unknown>;
  confidence: number | null;
  needsReview: boolean;
}

export interface ExtractedPart {
  part: PartMeta;
  electors: Elector[];
}
