"use client";

/**
 * Voter search.
 *
 * Search runs only when asked — a button click, or Enter in either box —
 * never on every keystroke. That is a deliberate change from an earlier,
 * type-to-search version: refreshing the results list mid-keystroke reflowed
 * the page under a phone's paste popover often enough to make pasting into
 * the box unreliable, and firing a request per character wastes both bandwidth
 * and database work.
 *
 * The EPIC number gets its own box, always visible, never mixed into the name
 * box: it should never be less than an exact match, and folding it through the
 * same fuzzy pipeline as a name was exactly the mixing that once made it not
 * work reliably.
 */
import { useRef, useState } from "react";

import { createClient } from "@/utils/supabase/client";
import { VoterModal } from "@/components/voter-modal";
import type { VoterResult as Result } from "@/utils/supabase/types";

const RELATION_LABEL: Record<string, string> = {
  father: "पिता",
  husband: "पति",
  mother: "माता",
  other: "अन्य",
};
const GENDER_LABEL: Record<string, string> = { M: "पुरुष", F: "स्त्री", O: "तृतीय लिंग" };

/** Attributes that keep mobile keyboards out of the way of a plain paste. */
const PASTE_FRIENDLY = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
} as const;

export default function Page() {
  const [q, setQ] = useState("");
  const [epic, setEpic] = useState("");
  const [relation, setRelation] = useState("");
  const [gender, setGender] = useState("");
  const [part, setPart] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Result | null>(null);

  // Guards against an old request winning a race against a newer one — the
  // same job the debounce ticket used to do, just triggered by clicks now
  // instead of keystrokes.
  const ticket = useRef(0);

  async function runSearch() {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (epic.trim()) params.set("epic", epic.trim());
    if (relation.trim()) params.set("relation", relation.trim());
    if (gender) params.set("gender", gender);
    if (part.trim()) params.set("part", part.trim());
    const query = params.toString();

    if (!query) {
      setResults([]);
      setSearched(false);
      setError(null);
      return;
    }

    const mine = ++ticket.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/search?${query}`);
      const json = await res.json();
      if (mine !== ticket.current) return; // superseded by a later click
      setError(json.error ?? null);
      setResults(json.results ?? []);
      setSearched(true);
    } catch (err) {
      if (mine === ticket.current) setError((err as Error).message);
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }

  function onEnter(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch();
    }
  }

  return (
    <main className="mx-auto min-h-svh w-full max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">मतदाता खोज</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            बीकानेर नगर निगम · वार्ड 1 — नाम हिंदी या अंग्रेज़ी में लिखें
            <span className="mx-1.5 opacity-40">·</span>
            Type a name in Hindi or English. Spelling does not have to be exact.
          </p>
        </div>
        <button
          onClick={async () => {
            await createClient().auth.signOut();
            // Full navigation so the proxy sees the cleared cookie.
            window.location.assign("/login");
          }}
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-md border px-3 py-1.5 text-sm"
        >
          साइन आउट
        </button>
      </header>

      <div className="bg-background/80 sticky top-0 z-10 -mx-1 border-b px-1 pb-3 pt-1 backdrop-blur">
        <div className="flex gap-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onEnter}
            placeholder="नाम या पिता/पति का नाम — name or father's/husband's name"
            className="border-input bg-background focus-visible:ring-ring w-full rounded-lg border px-4 py-3 text-base outline-none focus-visible:ring-2"
            {...PASTE_FRIENDLY}
          />
        </div>

        <div className="mt-2 flex gap-2">
          <input
            value={epic}
            onChange={(e) => setEpic(e.target.value)}
            onKeyDown={onEnter}
            placeholder="EPIC नंबर — e.g. IXQ0584201"
            className="border-input bg-background focus-visible:ring-ring w-full rounded-lg border px-4 py-2.5 font-mono text-sm outline-none focus-visible:ring-2"
            {...PASTE_FRIENDLY}
          />
          <button
            onClick={() => void runSearch()}
            disabled={loading}
            className="bg-primary text-primary-foreground shrink-0 rounded-lg px-5 text-sm font-medium disabled:opacity-60"
          >
            {loading ? "खोज रहे हैं…" : "खोजें"}
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            {showFilters ? "फ़िल्टर छुपाएँ" : "और फ़िल्टर (filters)"}
          </button>
          {!loading && searched && (
            <span className="text-muted-foreground">{results.length} परिणाम</span>
          )}
        </div>

        {showFilters && (
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <input
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
              onKeyDown={onEnter}
              placeholder="पिता / पति का नाम"
              className="border-input bg-background rounded-md border px-3 py-2 text-sm outline-none"
              {...PASTE_FRIENDLY}
            />
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className="border-input bg-background rounded-md border px-3 py-2 text-sm outline-none"
            >
              <option value="">लिंग — सभी</option>
              <option value="M">पुरुष</option>
              <option value="F">स्त्री</option>
              <option value="O">तृतीय लिंग</option>
            </select>
            <input
              value={part}
              onChange={(e) => setPart(e.target.value)}
              onKeyDown={onEnter}
              placeholder="भाग संख्या (part no.)"
              className="border-input bg-background rounded-md border px-3 py-2 text-sm outline-none"
              {...PASTE_FRIENDLY}
            />
          </div>
        )}
      </div>

      {error && (
        <p className="mt-6 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {!searched && !loading && (
        <p className="text-muted-foreground mt-16 text-center text-sm">
          नाम या EPIC नंबर लिखकर &quot;खोजें&quot; दबाएँ — enter a name or EPIC number and press Search
        </p>
      )}

      {searched && !loading && results.length === 0 && !error && (
        <p className="text-muted-foreground mt-16 text-center text-sm">
          कोई परिणाम नहीं मिला — वर्तनी बदलकर देखें (try a different spelling)
        </p>
      )}

      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {results.map((r) => (
          <li
            key={r.id}
            onClick={() => setSelected(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelected(r);
              }
            }}
            role="button"
            tabIndex={0}
            className="bg-card hover:border-primary/50 flex cursor-pointer gap-3 rounded-lg border p-3 shadow-sm transition-colors"
            style={r.is_deleted ? { opacity: 0.65 } : undefined}
          >
            {/* Only part 3 has per-person crops; everyone else shows no
                thumbnail here, but the click-through dialog always has an
                image — the full page scan when there is no individual crop. */}
            {r.photo_path && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={r.photo_path}
                alt=""
                width={84}
                height={104}
                loading="lazy"
                className="bg-muted h-[104px] w-[84px] shrink-0 rounded border object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-lg font-medium">{r.name_hi ?? "—"}</span>
                {r.is_deleted && (
                  <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                    विलोपित
                  </span>
                )}
              </div>
              <div className="text-muted-foreground truncate text-xs">{r.name_latin}</div>

              <div className="mt-1.5 text-sm">
                <span className="text-muted-foreground">
                  {RELATION_LABEL[r.relation_type ?? "other"]} का नाम:{" "}
                </span>
                <span>{r.relation_name_hi ?? "—"}</span>
              </div>

              <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
                आयु {r.age ?? "—"} · {GENDER_LABEL[r.gender ?? ""] ?? "—"}
                <br />
                EPIC: <span className="font-mono">{r.epic_no || "—"}</span>
                <br />
                <span className="font-mono opacity-70">{r.id}</span>
                <span className="opacity-70">
                  {" "}
                  · वार्ड {r.ward} · भाग {r.part_no} · क्रम {r.serial_no} · पृष्ठ {r.page_no}
                </span>
              </div>
              {r.section_label && (
                <div className="text-muted-foreground mt-1 truncate text-xs opacity-70">
                  {r.section_label}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {selected && <VoterModal voter={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
