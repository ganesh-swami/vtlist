"use client";

/**
 * Voter search — one box, results as you type.
 *
 * Deliberately plain: someone looking for a relative should be able to type a
 * name however they know how to spell it, in Hindi or in English letters, and
 * see faces. Filters stay collapsed until asked for.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { createClient } from "@/utils/supabase/client";

import type { VoterResult as Result } from "@/utils/supabase/types";


const RELATION_LABEL: Record<string, string> = {
  father: "पिता",
  husband: "पति",
  mother: "माता",
  other: "अन्य",
};
const GENDER_LABEL: Record<string, string> = { M: "पुरुष", F: "स्त्री", O: "तृतीय लिंग" };

export default function Page() {
  const [q, setQ] = useState("");
  const [relation, setRelation] = useState("");
  const [gender, setGender] = useState("");
  const [part, setPart] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (relation.trim()) p.set("relation", relation.trim());
    if (gender) p.set("gender", gender);
    if (part.trim()) p.set("part", part.trim());
    return p.toString();
  }, [q, relation, gender, part]);

  const latest = useRef(0);

  useEffect(() => {
    if (!params) {
      setResults([]);
      setSearched(false);
      return;
    }
    const ticket = ++latest.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?${params}`);
        const json = await res.json();
        if (ticket !== latest.current) return; // a newer keystroke already won
        setError(json.error ?? null);
        setResults(json.results ?? []);
        setSearched(true);
      } catch (err) {
        if (ticket === latest.current) setError((err as Error).message);
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [params]);

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
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="नाम, पिता/पति का नाम, मकान नं., EPIC…   e.g. Rameshwar / रामेश्वर / IXQ0584201"
          className="border-input bg-background focus-visible:ring-ring w-full rounded-lg border px-4 py-3 text-base outline-none focus-visible:ring-2"
        />

        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            {showFilters ? "फ़िल्टर छुपाएँ" : "और फ़िल्टर (filters)"}
          </button>
          {loading && <span className="text-muted-foreground">खोज रहे हैं…</span>}
          {!loading && searched && (
            <span className="text-muted-foreground">{results.length} परिणाम</span>
          )}
        </div>

        {showFilters && (
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <input
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
              placeholder="पिता / पति का नाम"
              className="border-input bg-background rounded-md border px-3 py-2 text-sm outline-none"
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
              placeholder="भाग संख्या (part no.)"
              className="border-input bg-background rounded-md border px-3 py-2 text-sm outline-none"
            />
          </div>
        )}
      </div>

      {error && (
        <p className="mt-6 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {!params && (
        <p className="text-muted-foreground mt-16 text-center text-sm">
          ऊपर नाम लिखकर खोजना शुरू करें
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
            className="bg-card flex gap-3 rounded-lg border p-3 shadow-sm"
            style={r.is_deleted ? { opacity: 0.65 } : undefined}
          >
            {/* Only part 3 has per-person crops; everyone else gets a link to
                the page scan instead, which is why this is conditional. */}
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
                आयु {r.age ?? "—"} · {GENDER_LABEL[r.gender ?? ""] ?? "—"} · मकान{" "}
                {r.house_no || "—"}
                {r.epic_no && (
                  <>
                    <br />
                    <span className="font-mono">{r.epic_no}</span>
                  </>
                )}
                <br />
                {r.page_image ? (
                  <a
                    href={r.page_image}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline underline-offset-2 opacity-70 hover:opacity-100"
                    title="मूल पृष्ठ देखें — open the roll page and zoom to this क्रम संख्या"
                  >
                    {r.id}
                  </a>
                ) : (
                  <span className="font-mono opacity-70">{r.id}</span>
                )}
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
    </main>
  );
}
