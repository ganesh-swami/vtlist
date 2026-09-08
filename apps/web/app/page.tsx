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
import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/utils/supabase/client";
import { VoterModal } from "@/components/voter-modal";
import { DeliveryDialog } from "@/components/delivery-dialog";
import type { VoterResult as Result } from "@/utils/supabase/types";

/** The भाग numbers this ward is split into. */
const PARTS = ["1", "2", "3", "4"];

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
  const [address, setAddress] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Suggestions for the address box: the मोहल्ला headings printed on the roll
  // (every elector has one) plus the addresses typed while handing out slips.
  // They are only hints — anything at all can be typed in the box.
  const [addressOptions, setAddressOptions] = useState<string[]>([]);

  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Result | null>(null);

  // Print selection lives outside the search state on purpose: a new search
  // replaces `results`, but a voter checked before that search must stay
  // checked after it — this Set is never touched by runSearch().
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  // Who has already been handed a पर्ची. Server-backed, so the green tick is
  // still there tomorrow, on another phone, for whoever is canvassing next —
  // the whole point of tracking it. Refreshed for whatever is on screen.
  const [delivered, setDelivered] = useState<Set<string>>(new Set());
  const [dialogFor, setDialogFor] = useState<Result | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deliverError, setDeliverError] = useState<string | null>(null);

  // The running total, fetched only when asked for. It is a whole-table count
  // and nobody needs it on the way to looking someone up.
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  async function showTotal() {
    setCounting(true);
    setDeliverError(null);
    try {
      const res = await fetch("/api/deliveries?count=1");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "गिनती नहीं मिली");
      setTotal(json.total);
    } catch (err) {
      setDeliverError((err as Error).message);
    } finally {
      setCounting(false);
    }
  }

  const refreshDelivered = useCallback(async (rows: Result[]) => {
    if (!rows.length) return;
    try {
      const res = await fetch(`/api/deliveries?ids=${rows.map((r) => r.id).join(",")}`);
      const json = await res.json();
      const ids: string[] = (json.deliveries ?? []).map((d: { voter_id: string }) => d.voter_id);
      setDelivered((prev) => {
        const next = new Set(prev);
        // Only the rows we just asked about are authoritative here: a voter
        // absent from this answer was not delivered, even if an earlier
        // search had marked them.
        for (const r of rows) next.delete(r.id);
        for (const id of ids) next.add(id);
        return next;
      });
    } catch {
      // A failed status check must not blank the list that is already useful.
    }
  }, []);

  useEffect(() => {
    void refreshDelivered(results);
  }, [results, refreshDelivered]);

  // Re-read each time the panel is opened, so an address added five minutes
  // ago in the delivery dialog is there to filter by now.
  useEffect(() => {
    if (!showFilters) return;
    fetch("/api/addresses")
      .then((r) => r.json())
      .then((j) => {
        const fromDeliveries: string[] = (j.addresses ?? []).flatMap(
          (a: { parent: string; child: string }) => [a.parent, a.child].filter(Boolean),
        );
        setAddressOptions([...new Set([...(j.sections ?? []), ...fromDeliveries])].sort());
      })
      .catch(() => setAddressOptions([]));
  }, [showFilters]);

  /**
   * Mark straight from the result card — no dialog.
   *
   * The voter is already identified by the row that was tapped, and every
   * other field is optional, so asking anything more would be a form standing
   * between a canvasser and the next doorstep. Details can still be added
   * afterwards through the header's पर्ची दे दी dialog, which upserts the
   * same row. The tick flips immediately and rolls back only if the write
   * actually fails.
   */
  async function markDelivered(id: string) {
    if (delivered.has(id)) return;
    setDelivered((prev) => new Set(prev).add(id));
    // Keep a total already on screen in step, rather than letting it go stale.
    setTotal((t) => (t == null ? t : t + 1));
    setDeliverError(null);
    try {
      const res = await fetch("/api/deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voterId: id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `सेव नहीं हुआ (${res.status})`);
      }
    } catch (err) {
      setDelivered((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setTotal((t) => (t == null ? t : t - 1));
      setDeliverError((err as Error).message);
    }
  }

  async function unmarkDelivered(id: string) {
    setDelivered((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setTotal((t) => (t == null ? t : t - 1));
    setDeliverError(null);
    try {
      const res = await fetch(`/api/deliveries?voterId=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("हटा नहीं सका");
    } catch (err) {
      setDelivered((prev) => new Set(prev).add(id)); // put it back
      setTotal((t) => (t == null ? t : t + 1));
      setDeliverError((err as Error).message);
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handlePrint() {
    const ids = [...selectedIds];
    if (!ids.length || printing) return;
    setPrinting(true);
    setPrintError(null);
    try {
      const res = await fetch("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `प्रिंट विफल (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `voter-parchi-${ids.length}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setPrintError((err as Error).message);
    } finally {
      setPrinting(false);
    }
  }

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
    if (address.trim()) params.set("address", address.trim());
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
          <button
            onClick={() => setSelectMode((v) => !v)}
            className={
              selectMode
                ? "rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-primary"
                : "text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            }
          >
            {selectMode ? "चयन बंद करें" : "प्रिंट के लिए चुनें"}
          </button>
          <button
            onClick={() => {
              setDialogFor(null);
              setDialogOpen(true);
            }}
            className="rounded-md border border-green-600 px-2 py-0.5 font-medium text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/40"
          >
            पर्ची दे दी
          </button>
          {total == null ? (
            <button
              onClick={() => void showTotal()}
              disabled={counting}
              className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline disabled:opacity-60"
            >
              {counting ? "गिन रहे हैं…" : "कितनी दे दी?"}
            </button>
          ) : (
            <span className="rounded-md border border-green-600 bg-green-50 px-2 py-0.5 font-medium text-green-800 dark:bg-green-950/40 dark:text-green-300">
              कुल {total} पर्ची दी गईं
              <button
                onClick={() => void showTotal()}
                disabled={counting}
                title="फिर से गिनें"
                className="ml-1.5 opacity-60 hover:opacity-100"
              >
                ↻
              </button>
            </span>
          )}
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
            <input
              list="address-filter-options"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={onEnter}
              placeholder="पता / मोहल्ला / गली — कुछ भी लिखें"
              className="border-input bg-background rounded-md border px-3 py-2 text-sm outline-none sm:col-span-3"
              {...PASTE_FRIENDLY}
            />
            <datalist id="address-filter-options">
              {addressOptions.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-6 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {deliverError && (
        <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {deliverError}
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
            onClick={() => (selectMode ? toggleSelect(r.id) : setSelected(r))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (selectMode) toggleSelect(r.id);
                else setSelected(r);
              }
            }}
            role="button"
            tabIndex={0}
            className={`bg-card flex cursor-pointer gap-3 rounded-lg p-3 shadow-sm transition-colors ${
              delivered.has(r.id)
                ? "border-2 border-green-600 dark:border-green-500"
                : "hover:border-primary/50 border"
            }`}
            style={r.is_deleted ? { opacity: 0.65 } : undefined}
          >
            {selectMode && (
              <input
                type="checkbox"
                checked={selectedIds.has(r.id)}
                onChange={() => toggleSelect(r.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label="प्रिंट के लिए चुनें"
                className="accent-primary mt-1 h-4 w-4 shrink-0"
              />
            )}
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
                {delivered.has(r.id) && (
                  <span
                    title="पर्ची दे दी गई"
                    className="shrink-0 rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-medium text-white"
                  >
                    ✓ दे दी
                  </span>
                )}
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
                  · वार्ड {r.ward} · भाग{" "}
                  <span className="text-foreground text-sm font-bold">{r.part_no}</span> · क्रम{" "}
                  <span className="text-foreground text-sm font-bold">{r.serial_no}</span> · पृष्ठ{" "}
                  {r.page_no}
                </span>
              </div>
              {r.section_label && (
                <div className="text-muted-foreground mt-1 truncate text-xs opacity-70">
                  {r.section_label}
                </div>
              )}

              <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                {delivered.has(r.id) ? (
                  <button
                    onClick={() => void unmarkDelivered(r.id)}
                    className="text-muted-foreground hover:text-foreground rounded border px-2 py-1 text-xs"
                  >
                    दे दी हटाएँ
                  </button>
                ) : (
                  <button
                    onClick={() => void markDelivered(r.id)}
                    className="rounded border border-green-600 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/40"
                  >
                    दे दी
                  </button>
                )}
                <button
                  onClick={() => {
                    setDialogFor(r);
                    setDialogOpen(true);
                  }}
                  className="text-muted-foreground hover:text-foreground rounded border px-2 py-1 text-xs"
                  title="पता, मोबाइल, कौन लाएगा"
                >
                  विवरण
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {selected && <VoterModal voter={selected} onClose={() => setSelected(null)} />}

      {dialogOpen && (
        <DeliveryDialog
          voter={dialogFor}
          parts={PARTS}
          onClose={() => setDialogOpen(false)}
          onSaved={(ids) =>
            setDelivered((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.add(id);
              return next;
            })
          }
        />
      )}

      {selectedIds.size > 0 && (
        <div className="bg-card fixed inset-x-0 bottom-4 z-20 mx-auto flex w-fit items-center gap-3 rounded-full border px-4 py-2 shadow-lg">
          <span className="text-sm font-medium">{selectedIds.size} चयनित</span>
          {printError && <span className="text-xs text-red-600 dark:text-red-400">{printError}</span>}
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
          >
            चयन हटाएँ
          </button>
          <button
            onClick={() => void handlePrint()}
            disabled={printing}
            className="bg-primary text-primary-foreground rounded-full px-4 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {printing ? "बन रही है…" : "प्रिंट करें"}
          </button>
        </div>
      )}
    </main>
  );
}
