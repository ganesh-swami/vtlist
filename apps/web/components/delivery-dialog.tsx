"use client";

/**
 * Recording that voters have been handed their पर्ची.
 *
 * Takes a list of भाग + क्रमांक rows rather than one, because slips are handed
 * over a household at a time: the whole family shares an address, a mobile and
 * whoever is bringing them, so typing those once and listing the क्रमांक is the
 * shape the work actually has. A row added with + defaults to the भाग above
 * it, since a household never straddles two.
 *
 * Opens two ways, differing only in whether the voter is known: from a search
 * result the first row arrives filled and locked, and from the header button
 * every row is typed — the two numbers printed on the slip itself, so someone
 * holding a counterfoil never has to search by name.
 *
 * Every field below the क्रमांक list is optional on purpose, and "ढूंढें" is a
 * way to check the numbers before committing, never a required step: saving
 * resolves anything still unresolved on its own.
 */
import { useEffect, useRef, useState } from "react";
import type { VoterResult } from "@/utils/supabase/types";

export interface AddressOption {
  id: string;
  parent: string;
  child: string;
}

interface Entry {
  key: number;
  part: string;
  serial: string;
  /** Filled once the numbers have been resolved to a real elector. */
  voter: VoterResult | null;
  error: string | null;
  /** True for the row the dialog was opened on, which must not be edited. */
  locked: boolean;
}

const RELATION_LABEL: Record<string, string> = {
  father: "पिता",
  husband: "पति",
  mother: "माता",
  other: "अन्य",
};

const FIELD =
  "border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

/**
 * A text box that suggests what has been typed before but never insists on it.
 * A datalist rather than a select: the whole point is that an address absent
 * from the list can simply be typed, and it joins the list next time.
 */
function Suggest({
  id, value, onChange, options, placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <>
      <input
        list={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={FIELD}
        autoComplete="off"
      />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

export function DeliveryDialog({
  voter, parts, onClose, onSaved,
}: {
  /** Already-resolved voter, when opened from a search result. */
  voter: VoterResult | null;
  parts: string[];
  onClose: () => void;
  onSaved: (voterIds: string[]) => void;
}) {
  const nextKey = useRef(1);
  const [entries, setEntries] = useState<Entry[]>(() => [
    {
      key: 0,
      part: voter?.part_no ?? parts[0] ?? "1",
      serial: voter ? String(voter.serial_no) : "",
      voter,
      error: null,
      locked: !!voter,
    },
  ]);

  const [addresses, setAddresses] = useState<AddressOption[]>([]);
  const [addressParent, setAddressParent] = useState("");
  const [addressChild, setAddressChild] = useState("");
  const [broughtBy, setBroughtBy] = useState("");
  const [mobile, setMobile] = useState("");
  const [note, setNote] = useState("");

  const [looking, setLooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/addresses")
      .then((r) => r.json())
      .then((j) => setAddresses(j.addresses ?? []))
      .catch(() => setAddresses([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const parentOptions = [...new Set(addresses.map((a) => a.parent).filter(Boolean))];
  // Child suggestions narrow to the chosen parent once there is one, so a
  // गली list does not fill up with streets from every other मोहल्ला.
  const childOptions = [
    ...new Set(
      addresses
        .filter((a) => !addressParent || a.parent === addressParent)
        .map((a) => a.child)
        .filter(Boolean),
    ),
  ];

  const patch = (key: number, changes: Partial<Entry>) =>
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...changes } : e)));

  function addRow() {
    setEntries((prev) => [
      ...prev,
      {
        key: nextKey.current++,
        // Same भाग as the row above: a household never straddles two.
        part: prev.at(-1)?.part ?? parts[0] ?? "1",
        serial: "",
        voter: null,
        error: null,
        locked: false,
      },
    ]);
  }

  const removeRow = (key: number) => setEntries((prev) => prev.filter((e) => e.key !== key));

  /** Resolve one row's भाग + क्रमांक to a voter, or throw with a readable reason. */
  async function resolveOne(entry: Entry): Promise<VoterResult> {
    if (entry.voter) return entry.voter;
    if (!entry.serial.trim()) throw new Error("क्रमांक संख्या लिखें");
    const res = await fetch(
      `/api/voter-lookup?part=${encodeURIComponent(entry.part)}&serial=${encodeURIComponent(entry.serial.trim())}`,
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "मतदाता नहीं मिला");
    return json.voter as VoterResult;
  }

  /**
   * Resolve every filled row.
   *
   * `showNames` is what separates the two buttons. "ढूंढें" exists precisely to
   * show who the numbers belong to, so it writes the resolved voter back into
   * the row. Save does not: it just saves, and putting a list of names on
   * screen in the moment before the dialog closes is noise, not confirmation.
   * Either way a row that failed keeps its own reason, because that is the one
   * thing the user still has to act on.
   */
  async function resolveAll(showNames: boolean): Promise<Entry[]> {
    const filled = entries.filter((e) => e.serial.trim() || e.voter);
    const settled = await Promise.all(
      filled.map(async (e) => {
        try {
          return { ...e, voter: await resolveOne(e), error: null };
        } catch (err) {
          return { ...e, voter: null, error: (err as Error).message };
        }
      }),
    );
    setEntries((prev) =>
      prev.map((e) => {
        const s = settled.find((x) => x.key === e.key);
        if (!s) return e;
        return showNames ? s : { ...e, error: s.error };
      }),
    );
    return settled;
  }

  async function lookup() {
    setLooking(true);
    setError(null);
    try {
      const settled = await resolveAll(true);
      if (!settled.length) setError("कम से कम एक क्रमांक संख्या लिखें");
    } finally {
      setLooking(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const settled = await resolveAll(false);
      if (!settled.length) throw new Error("कम से कम एक क्रमांक संख्या लिखें");

      const ok = settled.filter((e) => e.voter);
      const bad = settled.filter((e) => !e.voter);
      if (!ok.length) throw new Error("कोई भी मतदाता नहीं मिला — क्रमांक जाँच लें");

      // Every row shares the address, mobile and "कौन लाएगा" typed once above.
      const results = await Promise.all(
        ok.map(async (e) => {
          const res = await fetch("/api/deliveries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              voterId: e.voter!.id,
              addressParent,
              addressChild,
              broughtBy,
              mobile,
              note,
            }),
          });
          return { entry: e, ok: res.ok };
        }),
      );

      const saved = results.filter((r) => r.ok).map((r) => r.entry.voter!.id);
      if (saved.length) onSaved(saved);

      const failed = results.filter((r) => !r.ok).map((r) => r.entry);
      if (failed.length || bad.length) {
        // Keep the dialog open showing exactly which क्रमांक still need
        // attention, rather than closing on a partial success.
        setEntries((prev) =>
          prev.map((e) =>
            failed.some((f) => f.key === e.key) ? { ...e, error: "सेव नहीं हुआ" } : e,
          ),
        );
        setError(
          `${saved.length} सेव हुए, ${failed.length + bad.length} रह गए — नीचे लाल निशान देखें`,
        );
        return;
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Counted from what has been typed, not from what has been looked up —
  // the button has to be honest about how many it will save even when
  // "ढूंढें" was never pressed.
  const filledCount = entries.filter((e) => e.serial.trim() || e.voter).length;
  const anyTyped = filledCount > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card max-h-[92vh] w-full max-w-md overflow-y-auto rounded-lg border p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="पर्ची दे दी"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">पर्ची दे दी</h2>
          <button
            onClick={onClose}
            aria-label="बंद करें"
            className="hover:bg-muted -mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none"
          >
            ×
          </button>
        </div>

        <p className="text-muted-foreground mt-1 text-xs">
          एक साथ कई मतदाता जोड़ सकते हैं — नीचे + दबाएँ
        </p>

        <div className="mt-3 space-y-2">
          <div className="text-muted-foreground grid grid-cols-[7rem_1fr_2rem] gap-2 text-xs font-medium">
            <span>भाग संख्या</span>
            <span>क्रमांक संख्या</span>
            <span />
          </div>

          {entries.map((e) => (
            <div key={e.key}>
              <div className="grid grid-cols-[7rem_1fr_2rem] items-center gap-2">
                <select
                  value={e.part}
                  onChange={(ev) => patch(e.key, { part: ev.target.value, voter: null, error: null })}
                  disabled={e.locked}
                  className={`${FIELD} disabled:opacity-60`}
                >
                  {parts.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  value={e.serial}
                  inputMode="numeric"
                  onChange={(ev) => patch(e.key, { serial: ev.target.value, voter: null, error: null })}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") {
                      ev.preventDefault();
                      addRow();
                    }
                  }}
                  disabled={e.locked}
                  placeholder="जैसे 763"
                  className={`${FIELD} disabled:opacity-60 ${e.error ? "border-red-500" : ""}`}
                  autoComplete="off"
                />
                {entries.length > 1 && !e.locked ? (
                  <button
                    onClick={() => removeRow(e.key)}
                    aria-label="यह पंक्ति हटाएँ"
                    className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md border text-base leading-none"
                  >
                    ×
                  </button>
                ) : (
                  <span />
                )}
              </div>

              {e.voter && (
                <div className="text-muted-foreground mt-1 pl-1 text-xs">
                  ✓ <span className="text-foreground font-medium">{e.voter.name_hi ?? "—"}</span>
                  {" · "}
                  {RELATION_LABEL[e.voter.relation_type ?? "other"]}: {e.voter.relation_name_hi ?? "—"}
                  {e.voter.age != null && <> · आयु {e.voter.age}</>}
                </div>
              )}
              {e.error && <div className="mt-1 pl-1 text-xs text-red-600">{e.error}</div>}
            </div>
          ))}

          <div className="flex gap-2 pt-1">
            <button
              onClick={addRow}
              className="border-primary/60 text-primary hover:bg-primary/5 flex-1 rounded-md border border-dashed px-3 py-2 text-sm font-medium"
            >
              + और जोड़ें
            </button>
            <button
              onClick={() => void lookup()}
              disabled={looking || !anyTyped}
              className="bg-secondary text-secondary-foreground rounded-md border px-3 py-2 text-sm disabled:opacity-60"
            >
              {looking ? "…" : "ढूंढें"}
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t pt-4">
          <p className="text-muted-foreground text-xs">
            नीचे की जानकारी ऊपर के सभी मतदाताओं पर लागू होगी — सब वैकल्पिक है
          </p>

          <div>
            <label className="mb-1 block text-xs font-medium">पता — मोहल्ला / कॉलोनी</label>
            <Suggest
              id="address-parent"
              value={addressParent}
              onChange={setAddressParent}
              options={parentOptions}
              placeholder="पहले से जुड़े पते दिखेंगे, नया भी लिख सकते हैं"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">पता — गली / मकान</label>
            <Suggest
              id="address-child"
              value={addressChild}
              onChange={setAddressChild}
              options={childOptions}
              placeholder="जैसे गली नं 1"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">कौन लाएगा</label>
            <input
              value={broughtBy}
              onChange={(e) => setBroughtBy(e.target.value)}
              placeholder="कार्यकर्ता का नाम"
              className={FIELD}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">मोबाइल नंबर</label>
            <input
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              inputMode="tel"
              placeholder="10 अंक"
              className={`${FIELD} font-mono`}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">टिप्पणी</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="कोई और जानकारी"
              className={FIELD}
              autoComplete="off"
            />
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="hover:bg-muted flex-1 rounded-md border px-3 py-2 text-sm"
          >
            रद्द करें
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !anyTyped}
            className="flex-1 rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving
              ? "सेव हो रहा है…"
              : `दे दी — सेव करें${filledCount > 1 ? ` (${filledCount})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
