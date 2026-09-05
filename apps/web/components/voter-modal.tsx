"use client";

/**
 * Full detail view for one voter, opened by clicking their card.
 *
 * No network call: everything shown here already arrived with the search
 * result, so the dialog opens instantly. The image is whichever the row
 * actually has — part 3's individual crop when present, otherwise the scan of
 * the whole printed page (every part has one of those), so there is always
 * something to look at rather than a blank box.
 */
import { useEffect, useState } from "react";
import type { VoterResult as Result } from "@/utils/supabase/types";

const RELATION_LABEL: Record<string, string> = {
  father: "पिता",
  husband: "पति",
  mother: "माता",
  other: "अन्य",
};
const GENDER_LABEL: Record<string, string> = { M: "पुरुष", F: "स्त्री", O: "तृतीय लिंग" };

export function VoterModal({ voter, onClose }: { voter: Result; onClose: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const imageSrc = voter.photo_path ?? voter.page_image;
  const isFullPage = !voter.photo_path && !!voter.page_image;

  // Escape closes; background scroll is frozen while the dialog is open —
  // both matter more on a phone, where the list behind it is one long scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg border shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="मतदाता विवरण"
      >
        <button
          onClick={onClose}
          aria-label="बंद करें"
          className="bg-background/90 hover:bg-muted absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full border text-lg leading-none shadow-sm"
        >
          ×
        </button>

        <div className="bg-muted flex items-center justify-center">
          {imageSrc && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageSrc}
              alt=""
              className={isFullPage ? "max-h-[50vh] w-full object-contain" : "max-h-[50vh] object-contain"}
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="text-muted-foreground flex h-40 w-full items-center justify-center text-sm">
              कोई छवि उपलब्ध नहीं — no image available
            </div>
          )}
        </div>

        {isFullPage && imageSrc && !imgFailed && (
          <div className="border-b px-4 py-2 text-center text-xs">
            <span className="text-muted-foreground">
              यह पूरे पृष्ठ की तस्वीर है — क्रम संख्या {voter.serial_no} ढूंढें।{" "}
            </span>
            <a
              href={imageSrc}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              बड़ा करके देखें (open full size)
            </a>
          </div>
        )}

        <div className="p-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-xl font-semibold">{voter.name_hi ?? "—"}</h2>
            {voter.is_deleted && (
              <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                विलोपित
              </span>
            )}
          </div>
          {voter.name_latin && <div className="text-muted-foreground text-sm">{voter.name_latin}</div>}

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">
              {RELATION_LABEL[voter.relation_type ?? "other"]} का नाम
            </dt>
            <dd>
              {voter.relation_name_hi ?? "—"}
              {voter.relation_name_latin && (
                <span className="text-muted-foreground"> ({voter.relation_name_latin})</span>
              )}
            </dd>

            <dt className="text-muted-foreground">आयु</dt>
            <dd>{voter.age ?? "—"}</dd>

            <dt className="text-muted-foreground">लिंग</dt>
            <dd>{GENDER_LABEL[voter.gender ?? ""] ?? "—"}</dd>

            <dt className="text-muted-foreground">EPIC नंबर</dt>
            <dd className="font-mono">{voter.epic_no || "—"}</dd>

            {voter.section_label && (
              <>
                <dt className="text-muted-foreground">क्षेत्र</dt>
                <dd>{voter.section_label}</dd>
              </>
            )}

            <dt className="text-muted-foreground">रोल स्थिति</dt>
            <dd className="font-mono">
              वार्ड {voter.ward} · भाग {voter.part_no} · क्रम {voter.serial_no} · पृष्ठ {voter.page_no}
            </dd>

            <dt className="text-muted-foreground">आइडी</dt>
            <dd className="font-mono">{voter.id}</dd>
          </dl>

          {!isFullPage && voter.page_image && (
            <a
              href={voter.page_image}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block text-sm underline underline-offset-2"
            >
              मूल पृष्ठ देखें (view the source page)
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
