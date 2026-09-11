"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MANUAL, VENDORS, manualByKind, vendorById, type ManualSpec, type VendorSource } from "@/lib/sources";

/**
 * Adding a box to an app.
 *
 * Always the same three questions, in the same order, for every app on the
 * board and every kind of thing that can go on one:
 *
 *   1. what kind of box is this — a vendor that reports for itself, or a figure
 *      stated by hand;
 *   2. what is it;
 *   3. what does it need in order to work — the key, the id, the file.
 *
 * The assistant can answer the first two of those from a sentence — it fills
 * the form in and stops there, with the credential and the button left to a
 * person. It drafts; it never writes.
 *
 * The third step is the reason this exists at all. A credential pasted here is
 * tried immediately against the vendor, before the dialog closes, because the
 * failure is nearly always a key that is under-scoped or from the wrong
 * account — and that is fixable in the ten seconds while the dialog is still
 * open, and mystifying an hour later when a card is simply blank.
 */

const CARD = "#191514";
const EDGE = "#262120";
const HEAD = "#1D1918";
const INK = "#F3EDE7";
const INK_2 = "#CFC6BE";
const MUTED = "#8B817A";
const DIM = "#7C726B";
const ACCENT = "#D97757";
const OK = "#5FA777";

const MONO = { fontFamily: "var(--mono), monospace" } as const;
const SERIF = { fontFamily: "var(--serif), serif", fontWeight: 400 } as const;

type Pick =
  | { family: "vendor"; vendor: VendorSource }
  | { family: "manual"; spec: ManualSpec };

export function AddSource({ appId, tone = "quiet" }: { appId: string; tone?: "quiet" | "loud" }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: tone === "loud" ? "11px 16px" : "8px 12px",
          border: `1px solid ${tone === "loud" ? "#4A3B33" : "#322b28"}`,
          borderRadius: 9,
          background: tone === "loud" ? "#241C18" : "#1D1917",
          color: tone === "loud" ? INK : "#E5DDD5",
          fontFamily: "inherit",
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        <span style={{ color: ACCENT, fontSize: 14, lineHeight: 1 }}>+</span>
        Add a box
      </button>
      {open && <Dialog appId={appId} onClose={() => setOpen(false)} />}
    </>
  );
}

function Dialog({ appId, onClose }: { appId: string; onClose: () => void }) {
  const router = useRouter();
  const [pick, setPick] = useState<Pick | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** What the assistant filled in, kept beside the form so it can be checked. */
  const [draft, setDraft] = useState<{ why: string; check: string[]; costUsd: number } | null>(null);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  function choose(p: Pick) {
    setPick(p);
    setValues({});
    setDraft(null);
    setError(null);
  }

  /**
   * Hand the sentence to the assistant and put what comes back in the form.
   *
   * The draft lands in the ordinary fields, on the ordinary step, behind the
   * ordinary button — so checking it is reading the form you were going to
   * fill in anyway, and changing your mind is typing over it.
   */
  async function runDraft(wanted: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/assistant/box", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, text: wanted }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(out.error ?? "the assistant could not draft that");
        setBusy(false);
        return;
      }

      const d = out.draft as Record<string, string | number | undefined>;
      if (d.family === "vendor") {
        const vendor = vendorById(String(d.vendor));
        if (!vendor) {
          setError(`the assistant picked "${d.vendor}", which this build cannot read`);
          setBusy(false);
          return;
        }
        setPick({ family: "vendor", vendor });
        // Credential fields stay empty on purpose: the one part of this form
        // the assistant must never fill in is the part that is a secret.
        setValues({});
      } else {
        const spec = manualByKind(String(d.kind));
        if (!spec) {
          setError("the assistant could not settle on a shape — pick one below");
          setBusy(false);
          return;
        }
        setPick({ family: "manual", spec });
        const str = (v: string | number | undefined) => (v == null ? "" : String(v));
        setValues({
          name: str(d.name),
          vendor: str(d.vendor),
          monthly_usd: str(d.monthly_usd),
          cap: str(d.cap),
          unit: str(d.unit),
          used: str(d.used),
          reset_label: str(d.reset_label),
          note: str(d.note),
        });
      }
      setDraft({
        why: String(out.why ?? ""),
        check: Array.isArray(out.check) ? out.check.map(String) : [],
        costUsd: Number(out.costUsd ?? 0),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "the request did not go through");
    }
    setBusy(false);
  }

  async function submit() {
    if (!pick) return;
    setBusy(true);
    setError(null);

    try {
      if (pick.family === "vendor") {
        const parts = pick.vendor.fields.map((f) => (values[f.key] ?? "").trim());
        if (parts.some((p) => !p)) {
          setError("every part of the credential is needed");
          setBusy(false);
          return;
        }
        // Joined with "|" in the connector's own order. The operator used to
        // type that bar themselves, from a hint; two fields and a join is the
        // same string with one fewer thing to get wrong.
        const res = await fetch("/api/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            appId,
            vendor: pick.vendor.id,
            secret: parts.join("|"),
            label: (values.label ?? "").trim() || null,
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.ok === false) {
          setError(out.message ?? out.error ?? `${pick.vendor.label} refused the credential`);
          setBusy(false);
          return;
        }
        setDone(out.message ?? "connected");
      } else {
        const res = await fetch("/api/resources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId, kind: pick.spec.kind, ...values }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(out.error ?? "could not add");
          setBusy(false);
          return;
        }
        setDone("stated by hand · the row is marked manual on the board");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "the request did not go through");
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  function finish() {
    // The page is server-rendered from the tables on every request, so the
    // correct refresh is to ask the server again rather than patch state here.
    router.refresh();
    onClose();
  }

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,8,8,.74)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        zIndex: 60,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 660,
          maxHeight: "86vh",
          overflowY: "auto",
          borderRadius: 18,
          border: `1px solid ${EDGE}`,
          background: CARD,
          color: INK,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 12,
            padding: "18px 22px",
            background: HEAD,
            borderBottom: `1px solid ${EDGE}`,
          }}
        >
          <div style={{ ...SERIF, fontSize: 20 }}>
            {done ? "Added" : pick ? title(pick) : "Add a box"}
          </div>
          <div style={{ fontSize: 12, color: DIM }}>
            {done
              ? "nothing else is needed"
              : draft
                ? "drafted · check it, then add it"
                : pick
                  ? "what it is, and what it needs"
                  : "first: what kind of thing is this"}
          </div>
          <div style={{ flex: 1 }} />
          {pick && !done && (
            <button
              onClick={() => {
                setPick(null);
                setDraft(null);
                setError(null);
              }}
              style={linkBtn}
            >
              ← back
            </button>
          )}
          <button onClick={onClose} style={linkBtn}>
            close
          </button>
        </div>

        <div style={{ padding: 22 }}>
          {done ? (
            <Done message={done} onFinish={finish} />
          ) : !pick ? (
            <Chooser onPick={choose} onDraft={runDraft} busy={busy} />
          ) : (
            <>
              {draft && <Drafted {...draft} />}
              <Detail pick={pick} values={values} set={set} />
            </>
          )}

          {error && (
            <div
              style={{
                marginTop: 18,
                padding: "12px 14px",
                borderRadius: 10,
                border: `1px solid ${ACCENT}55`,
                background: "#231715",
                fontSize: 12.5,
                color: "#F0C3B4",
                lineHeight: 1.55,
              }}
            >
              {error}
            </div>
          )}

          {pick && !done && (
            <div style={{ display: "flex", gap: 10, marginTop: 22, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={{ ...btn, color: MUTED }}>
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                style={{
                  ...btn,
                  border: "1px solid transparent",
                  background: ACCENT,
                  color: "#1A1210",
                  opacity: busy ? 0.55 : 1,
                }}
              >
                {busy
                  ? pick.family === "vendor"
                    ? "Asking the vendor…"
                    : "Adding…"
                  : pick.family === "vendor"
                    ? "Connect and read now"
                    : "Add the row"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const title = (p: Pick) => (p.family === "vendor" ? p.vendor.label : p.spec.label);

/* ── step one: the kind of box ───────────────────────────────────────────── */

function Chooser({
  onPick,
  onDraft,
  busy,
}: {
  onPick: (p: Pick) => void;
  onDraft: (wanted: string) => void;
  busy: boolean;
}) {
  const [wanted, setWanted] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Ask value={wanted} onChange={setWanted} onSubmit={() => onDraft(wanted)} busy={busy} />

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ flex: 1, height: 1, background: EDGE }} />
        <span style={{ fontSize: 11, color: DIM }}>or pick it yourself</span>
        <span style={{ flex: 1, height: 1, background: EDGE }} />
      </div>

      <Group
        heading="Reports for itself"
        note="a credential, then it refills on every sync"
      >
        {VENDORS.map((v) => (
          <Option
            key={v.id}
            name={v.label}
            note={v.reports}
            need={`needs ${v.fields.map((f) => f.label.toLowerCase()).join(" + ")}`}
            onClick={() => onPick({ family: "vendor", vendor: v })}
          />
        ))}
      </Group>

      <Group
        heading="Stated by hand"
        note="for what no connector will ever report — marked manual wherever it appears"
      >
        {MANUAL.map((m) => (
          <Option
            key={m.kind}
            name={m.label}
            note={m.reports}
            need="needs no credential"
            onClick={() => onPick({ family: "manual", spec: m })}
          />
        ))}
      </Group>
    </div>
  );
}

/**
 * Describe it, and the assistant fills the form in.
 *
 * Sitting above the list rather than beside it as a third option, because it is
 * not a third kind of box — it is a faster route to one of the ten below. What
 * comes back is a form on the same step with the same button, so there is no
 * second way for something to reach the board.
 */
function Ask({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        border: `1px solid ${EDGE}`,
        borderRadius: 12,
        background: "#1C1817",
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: 5,
            background: ACCENT,
            color: "#1A1210",
            display: "grid",
            placeItems: "center",
            fontSize: 9,
          }}
        >
          ◈
        </span>
        <span style={{ fontSize: 13.5 }}>Add with the assistant</span>
        <span style={{ fontSize: 11.5, color: DIM }}>
          it fills the form in · nothing is added until you press the button
        </span>
      </div>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter submits; plain Enter is a newline, because a sentence
          // about a cost often wants a second one about where it came from.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim() && !busy) onSubmit();
        }}
        rows={3}
        placeholder="we pay $12 a month to Cloudflare for the domain — or: connect our Stripe account"
        style={{ ...input, marginTop: 12, resize: "vertical", lineHeight: 1.5 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
        <span style={{ fontSize: 11.5, color: DIM, lineHeight: 1.5 }}>
          It may only copy figures out of your sentence. It will not supply a price it happens to
          know, and it never sees or fills in a credential.
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onSubmit}
          disabled={busy || !value.trim()}
          style={{
            ...btn,
            border: "1px solid transparent",
            background: ACCENT,
            color: "#1A1210",
            padding: "9px 14px",
            whiteSpace: "nowrap",
            opacity: busy || !value.trim() ? 0.5 : 1,
          }}
        >
          {busy ? "Drafting…" : "Draft it"}
        </button>
      </div>
    </div>
  );
}

/**
 * What the assistant filled in, and what it wants you to check.
 *
 * Above the fields rather than below them: the list is a set of instructions
 * for reading the form underneath it, and instructions that arrive after the
 * thing they describe get read second or not at all.
 */
function Drafted({ why, check, costUsd }: { why: string; check: string[]; costUsd: number }) {
  return (
    <div
      style={{
        border: `1px solid #3A322E`,
        borderRadius: 12,
        background: "#1C1817",
        padding: 16,
        marginBottom: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
        <span style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "#857B74" }}>
          Drafted by the assistant
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ ...MONO, fontSize: 11, color: DIM }}>
          {costUsd > 0 ? `$${costUsd.toFixed(4)} of model time` : "cost not reported"}
        </span>
      </div>

      {why && <div style={{ fontSize: 12.5, color: INK_2, marginTop: 9, lineHeight: 1.6 }}>{why}</div>}

      {check.length > 0 && (
        <ul style={{ margin: "12px 0 0", paddingLeft: 18, display: "grid", gap: 5 }}>
          {check.map((c, i) => (
            <li key={i} style={{ fontSize: 12, color: MUTED, lineHeight: 1.55 }}>
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Group({
  heading,
  note,
  children,
}: {
  heading: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <span
          style={{
            fontSize: 11,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "#857B74",
          }}
        >
          {heading}
        </span>
        <span style={{ fontSize: 11.5, color: DIM }}>{note}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function Option({
  name,
  note,
  need,
  onClick,
}: {
  name: string;
  note: string;
  need: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "13px 15px",
        borderRadius: 12,
        border: `1px solid ${EDGE}`,
        background: "#1C1817",
        color: INK,
        fontFamily: "inherit",
        cursor: "pointer",
      }}
    >
      <div style={{ fontSize: 13.5 }}>{name}</div>
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 5, lineHeight: 1.5 }}>{note}</div>
      <div style={{ ...MONO, fontSize: 10.5, color: DIM, marginTop: 7 }}>{need}</div>
    </button>
  );
}

/* ── step two: what it is, and what it needs ─────────────────────────────── */

function Detail({
  pick,
  values,
  set,
}: {
  pick: Pick;
  values: Record<string, string>;
  set: (k: string, v: string) => void;
}) {
  if (pick.family === "vendor") {
    const v = pick.vendor;
    return (
      <div>
        <Says>{v.reports}</Says>
        <Where>{v.where}</Where>
        {v.env && (
          <div style={{ ...MONO, fontSize: 11.5, color: DIM, marginTop: 8, lineHeight: 1.5 }}>
            {v.env.name} — {v.env.what}
          </div>
        )}

        {v.fields.map((f) =>
          f.multiline ? (
            <Field key={f.key} label={f.label}>
              <textarea
                value={values[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder}
                rows={7}
                style={{ ...input, ...MONO, fontSize: 12, resize: "vertical" }}
              />
            </Field>
          ) : (
            <Field key={f.key} label={f.label}>
              <input
                value={values[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder}
                // The secret is posted, stored server-side and never read back
                // into this form, so masking it here would buy nothing and cost
                // the one check that catches a truncated paste.
                spellCheck={false}
                autoComplete="off"
                style={{ ...input, ...MONO, fontSize: 13 }}
              />
            </Field>
          ),
        )}

        <Field label="Label (optional)">
          <input
            value={values.label ?? ""}
            onChange={(e) => set("label", e.target.value)}
            placeholder="which account this key belongs to"
            style={input}
          />
        </Field>
      </div>
    );
  }

  const m = pick.spec;
  return (
    <div>
      <Says>{m.reports}</Says>

      <Field label="What is it">
        <input
          autoFocus
          value={values.name ?? ""}
          onChange={(e) => set("name", e.target.value)}
          placeholder={
            m.kind === "revenue" ? "App Store payouts" : m.kind === "metered" ? "Push notifications" : "Domain renewal"
          }
          style={input}
        />
      </Field>

      <Field label="Who bills it">
        <input
          value={values.vendor ?? ""}
          onChange={(e) => set("vendor", e.target.value)}
          placeholder="cloudflare"
          style={input}
        />
      </Field>

      {m.asks.includes("monthly") && (
        <Field label={m.kind === "revenue" ? "This month, USD" : "Monthly, USD"}>
          <input
            value={values.monthly_usd ?? ""}
            onChange={(e) => set("monthly_usd", e.target.value)}
            placeholder="12.00"
            inputMode="decimal"
            style={{ ...input, ...MONO }}
          />
        </Field>
      )}

      {m.asks.includes("ceiling") && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Ceiling">
              <input
                value={values.cap ?? ""}
                onChange={(e) => set("cap", e.target.value)}
                placeholder="50000"
                inputMode="decimal"
                style={{ ...input, ...MONO }}
              />
            </Field>
            <Field label="Unit">
              <input
                value={values.unit ?? ""}
                onChange={(e) => set("unit", e.target.value)}
                placeholder="calls"
                style={input}
              />
            </Field>
            <Field label="Reading (optional)">
              <input
                value={values.used ?? ""}
                onChange={(e) => set("used", e.target.value)}
                placeholder="leave blank"
                inputMode="decimal"
                style={{ ...input, ...MONO }}
              />
            </Field>
          </div>
          <div style={{ fontSize: 11.5, color: DIM, marginTop: 8, lineHeight: 1.55 }}>
            Leave the reading blank unless something is genuinely counting. The board draws
            <span style={MONO}> ? / {values.cap || "cap"} </span>
            for a ceiling nothing measures, and that is the truthful picture — a zero here would
            claim the ceiling is untouched.
          </div>
          <Field label="Resets">
            <input
              value={values.reset_label ?? ""}
              onChange={(e) => set("reset_label", e.target.value)}
              placeholder="resets 00:00 Pacific · or: does not reset"
              style={input}
            />
          </Field>
        </>
      )}

      <Field label="Note (optional)">
        <input
          value={values.note ?? ""}
          onChange={(e) => set("note", e.target.value)}
          placeholder="where this figure came from"
          style={input}
        />
      </Field>
    </div>
  );
}

function Done({ message, onFinish }: { message: string; onFinish: () => void }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: OK }} />
        <span style={{ color: INK_2 }}>{message}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 22 }}>
        <button
          onClick={onFinish}
          style={{ ...btn, border: "1px solid transparent", background: ACCENT, color: "#1A1210" }}
        >
          Show it on the board
        </button>
      </div>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function Says({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: INK_2, lineHeight: 1.6 }}>{children}</div>;
}

function Where({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.55 }}>{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginTop: 18 }}>
      <span
        style={{
          display: "block",
          marginBottom: 7,
          fontSize: 11,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: "#857B74",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 9,
  border: `1px solid ${EDGE}`,
  background: "#141110",
  color: INK,
  padding: "11px 13px",
  fontSize: 13.5,
  fontFamily: "inherit",
  outline: "none",
};

const btn: React.CSSProperties = {
  borderRadius: 9,
  border: `1px solid ${EDGE}`,
  background: "transparent",
  color: INK,
  padding: "10px 16px",
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: MUTED,
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
};
