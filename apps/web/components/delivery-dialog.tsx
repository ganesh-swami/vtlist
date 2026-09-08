"use client";

/**
 * Recording that a voter has been handed their पर्ची.
 *
 * Opens two ways, and the difference is only whether the voter is known yet:
 * from a search result the voter comes in already resolved, and from the
 * header button the dialog first asks for भाग संख्या and क्रमांक संख्या — the
 * two numbers printed on the slip itself — and looks the person up, so a
 * canvasser holding a counterfoil never has to search by name.
 *
 * Every field below the voter is optional on purpose. The point is that
 * someone at a doorstep can tap once and move on; the address, mobile and
 * "कौन लाएगा" get filled in when they happen to be known.
 */
import { useEffect, useRef, useState } from "react";
import type { VoterResult } from "@/utils/supabase/types";

export interface AddressOption {
  id: string;
  parent: string;
  child: string;
}

export interface DeliveryDetails {
  addressParent?: string;
  addressChild?: string;
  broughtBy?: string;
  mobile?: string;
  note?: string;
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
  onSaved: (voterId: string) => void;
}) {
  const [found, setFound] = useState<VoterResult | null>(voter);
  const [part, setPart] = useState(voter?.part_no ?? parts[0] ?? "1");
  const [serial, setSerial] = useState(voter ? String(voter.serial_no) : "");
  const [looking, setLooking] = useState(false);

  const [addresses, setAddresses] = useState<AddressOption[]>([]);
  const [addressParent, setAddressParent] = useState("");
  const [addressChild, setAddressChild] = useState("");
  const [broughtBy, setBroughtBy] = useState("");
  const [mobile, setMobile] = useState("");
  const [note, setNote] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serialRef = useRef<HTMLInputElement>(null);

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

  /** Resolve भाग + क्रमांक to a voter, or throw with a readable reason. */
  async function resolve(): Promise<VoterResult> {
    if (!serial.trim()) throw new Error("क्रमांक संख्या लिखें");
    const res = await fetch(
      `/api/voter-lookup?part=${encodeURIComponent(part)}&serial=${encodeURIComponent(serial.trim())}`,
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "मतदाता नहीं मिला");
    return json.voter as VoterResult;
  }

  /** The "ढूंढें" button — shows who the numbers belong to before saving. */
  async function lookup() {
    setLooking(true);
    setError(null);
    try {
      setFound(await resolve());
    } catch (err) {
      setFound(null);
      setError((err as Error).message);
      if (!serial.trim()) serialRef.current?.focus();
    } finally {
      setLooking(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // "ढूंढें" is a convenience, not a step: someone who typed the two
      // numbers and went straight for save gets the lookup done for them
      // here, so a delivery is never lost to a button they did not press.
      const voterRow = found ?? (await resolve());
      if (!found) setFound(voterRow);

      const res = await fetch("/api/deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voterId: voterRow.id,
          addressParent,
          addressChild,
          broughtBy,
          mobile,
          note,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "सेव नहीं हुआ");
      onSaved(voterRow.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

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

        <div className="mt-4 grid grid-cols-[7rem_1fr] gap-2">
          <div>
            <label className="mb-1 block text-xs font-medium">भाग संख्या</label>
            <select
              value={part}
              onChange={(e) => {
                setPart(e.target.value);
                setFound(null);
              }}
              disabled={!!voter}
              className={`${FIELD} disabled:opacity-60`}
            >
              {parts.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">क्रमांक संख्या</label>
            <div className="flex gap-2">
              <input
                ref={serialRef}
                value={serial}
                inputMode="numeric"
                onChange={(e) => {
                  setSerial(e.target.value);
                  setFound(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void lookup(); // show who it is; Enter is a peek, not a commit
                  }
                }}
                disabled={!!voter}
                placeholder="जैसे 763"
                className={`${FIELD} disabled:opacity-60`}
                autoComplete="off"
              />
              {!voter && (
                <button
                  onClick={() => void lookup()}
                  disabled={looking}
                  className="bg-secondary text-secondary-foreground shrink-0 rounded-md border px-3 text-sm disabled:opacity-60"
                >
                  {looking ? "…" : "ढूंढें"}
                </button>
              )}
            </div>
          </div>
        </div>

        {found && (
          <div className="bg-muted/50 mt-3 rounded-md border p-3 text-sm">
            <div className="font-medium">{found.name_hi ?? "—"}</div>
            <div className="text-muted-foreground text-xs">
              {RELATION_LABEL[found.relation_type ?? "other"]} का नाम: {found.relation_name_hi ?? "—"}
              {found.age != null && <> · आयु {found.age}</>}
            </div>
            <div className="text-muted-foreground mt-0.5 text-xs">
              भाग <span className="text-foreground font-bold">{found.part_no}</span> · क्रम{" "}
              <span className="text-foreground font-bold">{found.serial_no}</span>
              {found.epic_no && <> · {found.epic_no}</>}
            </div>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">
              पता — मोहल्ला / कॉलोनी <span className="text-muted-foreground">(वैकल्पिक)</span>
            </label>
            <Suggest
              id="address-parent"
              value={addressParent}
              onChange={setAddressParent}
              options={parentOptions}
              placeholder="पहले से जुड़े पते दिखेंगे, नया भी लिख सकते हैं"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">
              पता — गली / मकान <span className="text-muted-foreground">(वैकल्पिक)</span>
            </label>
            <Suggest
              id="address-child"
              value={addressChild}
              onChange={setAddressChild}
              options={childOptions}
              placeholder="जैसे गली नं 1"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">
              कौन लाएगा <span className="text-muted-foreground">(वैकल्पिक)</span>
            </label>
            <input
              value={broughtBy}
              onChange={(e) => setBroughtBy(e.target.value)}
              placeholder="कार्यकर्ता का नाम"
              className={FIELD}
              autoComplete="off"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium">
              मोबाइल नंबर <span className="text-muted-foreground">(वैकल्पिक)</span>
            </label>
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
            <label className="mb-1 block text-xs font-medium">
              टिप्पणी <span className="text-muted-foreground">(वैकल्पिक)</span>
            </label>
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
            disabled={saving || (!found && !serial.trim())}
            className="flex-1 rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "सेव हो रहा है…" : "दे दी — सेव करें"}
          </button>
        </div>
        {!found && (
          <p className="text-muted-foreground mt-2 text-center text-xs">
            भाग और क्रमांक भरकर सीधे सेव कर सकते हैं — &quot;ढूंढें&quot; ज़रूरी नहीं
          </p>
        )}
      </div>
    </div>
  );
}
