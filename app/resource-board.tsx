import Link from "next/link";
import type { App, Connection, Resource } from "@/lib/apps";
import { connectionState } from "@/lib/apps";
import { costMtd, counted, coverage, ghostVendors, revenueMtd, sourceRank, usd } from "@/lib/money";
import type { Judgement } from "@/lib/status";
import { BoardChrome } from "./board-chrome";

/**
 * One app's resources, as a document.
 *
 * The previous board was a pannable canvas, and its default framing put every
 * caption at four or five apparent pixels while the figures they qualify
 * rendered at twelve to sixteen. On a console whose honesty lives in those
 * captions — "not extra spend", "reports no figure", "$0.00 is a measurement" —
 * a view that shows the numbers and hides the qualifications is the wrong view.
 * A scrolling document has one scale, and it is readable.
 */

/* ── palette ─────────────────────────────────────────────────────────────── */

const BG = "#141110";
const CARD = "#191514";
const EDGE = "#262120";
const ROW = "#221E1D";
const HEAD = "#1D1918";
const TRACK = "#2A2523";

const INK = "#F3EDE7";
const INK_2 = "#CFC6BE";
const INK_3 = "#B5ABA3";
const MUTED = "#8B817A";
const DIM = "#7C726B";
const FAINT = "#6E645D";

const ACCENT = "#D97757";
const OK = "#5FA777";
const WARN = "#C8894F";
const COOL = "#8B7BB8";

const TONE: Record<string, string> = { ok: OK, warn: WARN, crit: ACCENT, neutral: "#4A413C", unknown: "#4A413C" };

const MONO = { fontFamily: "var(--mono), monospace" } as const;
const SERIF = { fontFamily: "var(--serif), serif", fontWeight: 400 } as const;
const CLIP = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/** Wide enough for the four-column ceilings table, no wider. */
const MAX_W = 1360;

const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US"));

export function ResourceBoard({
  app,
  resources: all,
  connections,
  judgements,
  spend,
  gaps,
}: {
  app: App;
  resources: Resource[];
  connections: Connection[];
  judgements: Record<string, Judgement>;
  spend: Judgement;
  /** Things known to cost money that nothing reports. Stated, not inferred. */
  gaps: { name: string; need: string }[];
}) {
  const resources = all.filter((r) => !r.is_sample);

  const cost = costMtd(resources);
  const revenue = revenueMtd(resources);
  const ghosts = ghostVendors(resources);
  const contribution = revenue - cost;

  const won = counted(resources);
  // Counted ceilings first: a row with a reading is the one you can act on, and
  // the three that measure nothing should not sit between them.
  const ceilings = resources
    .filter((r) => r.kind === "metered")
    .sort((a, b) => Number(a.used == null) - Number(b.used == null));
  const flow = won.filter((r) => r.kind === "usage");
  const ledger = resources.filter(
    (r) => r.kind === "usage" && sourceRank(r) === 2 && !won.some((w) => w.id === r.id),
  );
  const fixed = won.filter((r) => r.kind === "fixed");
  const revenueRows = resources.filter((r) => r.kind === "revenue");

  const fixedTotal = fixed.reduce((t, r) => t + (r.mtd_usd ?? 0), 0);
  const live = connections.filter((c) => connectionState(c) === "connected").length;
  const lastSync = connections
    .map((c) => c.last_sync_at)
    .filter((v): v is string => v != null)
    .sort()
    .pop();

  // Revenue has three states, not two. "Nobody reports it" and "two connectors
  // answered and both said zero" were rendering as the same $0.00, which is the
  // one confusion this console exists to prevent.
  const revenueKnown = revenueRows.length > 0;

  return (
    <main style={{ minHeight: "100vh", background: BG, color: INK }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "18px 28px",
          borderBottom: `1px solid ${EDGE}`,
          // The rule spans the window; what sits on it does not.
          justifyContent: "center",
          position: "sticky",
          top: 0,
          background: "rgba(20,17,16,.93)",
          backdropFilter: "blur(8px)",
          zIndex: 5,
        }}
      >
        <div style={{ width: "100%", maxWidth: MAX_W, display: "flex", alignItems: "center", gap: 20 }}>
        <div>
          <div style={{ ...SERIF, fontSize: 26, lineHeight: 1.1 }}>{app.name}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            <Link href="/" style={{ color: MUTED }}>
              portfolio
            </Link>{" "}
            · {resources.length} rows · {live} of {connections.length} connections live
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: MUTED }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: lastSync ? OK : WARN,
              boxShadow: `0 0 0 3px ${lastSync ? "rgba(95,167,119,.16)" : "rgba(200,137,79,.16)"}`,
            }}
          />
          <span>{lastSync ? `last sync ${ago(lastSync)}` : "never synced"}</span>
        </div>
        <BoardChrome />
        </div>
      </header>

      {/* Centred and bounded. Line lengths on a 2560-wide display were running
          the full width of the glass, which is unreadable for prose and makes
          a four-column table look like an accident. */}
      <div
        style={{
          maxWidth: MAX_W,
          margin: "0 auto",
          padding: "24px 28px 56px",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {/* ── the four figures everything else explains ───────────── */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
            gap: 1,
            background: EDGE,
            border: `1px solid ${EDGE}`,
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <Kpi
            label="Cost MTD"
            value={usd(cost)}
            color={spend.tone === "neutral" ? INK : TONE[spend.tone]}
            note={
              fixedTotal > 0 && cost > 0
                ? `${Math.round((fixedTotal / cost) * 100)}% fixed`
                : spend.why
            }
          />
          <Kpi
            label="Revenue"
            value={revenueKnown ? usd(revenue) : "—"}
            color={INK}
            note={revenueKnown ? "measured · both connectors answered" : "no revenue source attached"}
          />
          <Kpi
            label="Margin"
            value={revenue > 0 ? `${Math.round(((revenue - cost) / revenue) * 100)}%` : "—"}
            color={INK}
            note={revenue > 0 ? "of revenue" : "undefined at zero revenue"}
          />
          <Kpi
            label="Contribution"
            value={revenueKnown ? usd(contribution) : "—"}
            color={revenueKnown && contribution < 0 ? ACCENT : INK}
            note={revenueKnown ? "this month" : "unknown while revenue is"}
          />
        </section>

        {/* ── ceilings ─────────────────────────────────────────────── */}
        <section>
          <Heading note={`things that run out · ${ceilings.length} rows`}>Ceilings</Heading>
          <div style={{ border: `1px solid ${EDGE}`, borderRadius: 14, overflow: "hidden", background: CARD }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)",
                gap: 16,
                padding: "11px 20px",
                background: HEAD,
                fontSize: 11,
                letterSpacing: ".07em",
                textTransform: "uppercase",
                color: "#857B74",
                borderBottom: `1px solid ${EDGE}`,
              }}
            >
              <div>what</div>
              <div>reading</div>
              <div>resets</div>
              <div>counted by</div>
            </div>
            {ceilings.map((r) => {
              const j = judgements[r.id];
              const tone = TONE[j?.tone ?? "neutral"];
              const pct = r.cap && r.used != null ? Math.min(100, (r.used / r.cap) * 100) : 0;
              const money = r.unit === "USD";
              return (
                <div
                  key={r.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)",
                    gap: 16,
                    padding: "14px 20px",
                    borderBottom: `1px solid ${ROW}`,
                    alignItems: "center",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ width: 3, height: 26, borderRadius: 2, background: tone, flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, ...CLIP }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: DIM, ...CLIP }}>{subtitle(r, j)}</div>
                    </div>
                  </div>
                  <div>
                    <div style={{ ...MONO, fontSize: 13, color: r.used == null ? DIM : INK_2 }}>
                      {r.used == null
                        ? `? / ${num(r.cap)} ${r.unit ?? ""}`
                        : money
                          ? `${usd(r.used)} / $${num(r.cap)}`
                          : `${num(r.used)} / ${num(r.cap)} ${r.unit ?? ""}`}
                    </div>
                    <div style={{ height: 4, borderRadius: 3, background: TRACK, marginTop: 7, overflow: "hidden" }}>
                      {/* Proportional, with a 2px floor that marks non-zero.
                          143 of 50,000 would otherwise draw nothing at all. */}
                      <div
                        style={{
                          height: "100%",
                          borderRadius: 3,
                          width: `${pct}%`,
                          minWidth: (r.used ?? 0) > 0 ? 2 : 0,
                          background: tone,
                        }}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5, color: INK_3 }}>{resetLabel(r)}</div>
                  <div style={{ fontSize: 12.5, color: r.used == null ? DIM : INK_3 }}>{countedBy(r)}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── flow and attribution ─────────────────────────────────── */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 20 }}>
          <div>
            <Heading note="money with no ceiling">Flow</Heading>
            <div style={{ border: `1px solid ${EDGE}`, borderRadius: 14, background: CARD, overflow: "hidden" }}>
              {flow.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "14px 18px",
                    borderBottom: `1px solid ${ROW}`,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, ...CLIP }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: DIM, ...CLIP }}>{flowNote(r)}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ ...MONO, fontSize: 14 }}>{usd(r.mtd_usd)}</div>
                    <div style={{ ...MONO, fontSize: 11, color: MUTED }}>
                      {r.run_rate_usd == null ? "no rate yet" : `${usd(r.run_rate_usd)}/mo`}
                    </div>
                  </div>
                </div>
              ))}
              {!flow.length && <Empty>No metered spend has been reported for this app.</Empty>}
            </div>
          </div>

          <div>
            <Heading note="the same money, split up">Attribution</Heading>
            <Attribution rows={ledger} cov={coverage(resources, ledger[0]?.vendor ?? "")} />
          </div>
        </section>

        {/* ── fixed and revenue ────────────────────────────────────── */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 20 }}>
          <div>
            <Heading>Fixed</Heading>
            <div style={{ border: `1px solid ${EDGE}`, borderRadius: 14, background: CARD, overflow: "hidden" }}>
              {fixed.map((r, i) => (
                <Line
                  key={r.id}
                  last={i === fixed.length - 1}
                  name={r.name}
                  note={r.source === "manual" ? `manual · ${r.projection_note ?? "entered by hand"}` : r.reset_label ?? ""}
                  noteTone={r.source === "manual" ? WARN : DIM}
                  amount={usd(r.mtd_usd)}
                />
              ))}
              {!fixed.length && <Empty>No fixed monthly line is attached to this app.</Empty>}
            </div>
          </div>

          <div>
            <Heading>Revenue</Heading>
            <div style={{ border: `1px solid ${EDGE}`, borderRadius: 14, background: CARD, overflow: "hidden" }}>
              {revenueRows.map((r, i) => (
                <Line
                  key={r.id}
                  last={i === revenueRows.length - 1}
                  name={r.name}
                  note={r.reset_label ?? ""}
                  noteTone={DIM}
                  amount={usd(r.mtd_usd)}
                />
              ))}
              {!revenueKnown && (
                <Empty>
                  No revenue source is attached, so revenue is unknown rather than zero. Nothing on this page
                  reports it as $0.00.
                </Empty>
              )}
            </div>
          </div>
        </section>

        {/* ── the gaps, said out loud ──────────────────────────────── */}
        {(gaps.length > 0 || ghosts.length > 0) && (
          <section>
            <Heading>Not measured</Heading>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {/* A vendor that bills without reporting is derived from the rows;
                  the standing list names the same thing with the fix attached.
                  Rendering both put "google spend" on screen twice, once vaguely. */}
              {ghosts
                .filter((v) => !gaps.some((g) => g.name.toLowerCase().startsWith(v.toLowerCase())))
                .map((v) => (
                  <Chip key={v} name={`${v} spend`} need="bills but reports nothing" />
                ))}
              {gaps.map((g) => (
                <Chip key={g.name} name={g.name} need={g.need} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function Kpi({ label, value, note, color }: { label: string; value: string; note: string; color: string }) {
  return (
    <div style={{ background: CARD, padding: "18px 20px" }}>
      <div style={{ fontSize: 11.5, letterSpacing: ".08em", textTransform: "uppercase", color: MUTED }}>{label}</div>
      <div style={{ ...MONO, fontSize: 27, marginTop: 8, whiteSpace: "nowrap", color }}>{value}</div>
      <div style={{ fontSize: 11.5, color: DIM, marginTop: 6 }}>{note}</div>
    </div>
  );
}

function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
      <h2 style={{ ...SERIF, margin: 0, fontSize: 20 }}>{children}</h2>
      {note && <span style={{ fontSize: 12, color: DIM }}>{note}</span>}
    </div>
  );
}

function Line({
  name,
  note,
  amount,
  noteTone,
  last,
}: {
  name: string;
  note: string;
  amount: string;
  noteTone: string;
  last: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 14,
        padding: "14px 18px",
        borderBottom: last ? "none" : `1px solid ${ROW}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, ...CLIP }}>{name}</div>
        <div style={{ fontSize: 11, color: noteTone, ...CLIP }}>{note}</div>
      </div>
      <div style={{ ...MONO, fontSize: 14, flexShrink: 0 }}>{amount}</div>
    </div>
  );
}

/**
 * The ledger's account of money already counted elsewhere.
 *
 * Given its own card, under a heading that says "the same money", with a
 * remainder row that makes the parts reconcile to the whole. Laid out as a
 * peer list beside the invoice, a reader adds both columns and gets double.
 */
function Attribution({ rows, cov }: { rows: Resource[]; cov: { pct: number; unattributed: number } | null }) {
  if (!rows.length || !cov) {
    return (
      <div style={{ border: `1px solid ${EDGE}`, borderRadius: 14, background: CARD, padding: 18 }}>
        <div style={{ fontSize: 12.5, color: DIM, lineHeight: 1.6 }}>
          Nothing here breaks a vendor invoice down further. An app that instruments its own calls can say
          which operation spent what; this one does not, for any vendor with an invoice.
        </div>
      </div>
    );
  }

  const total = rows.reduce((t, r) => t + (r.mtd_usd ?? 0), 0);
  const invoice = total + cov.unattributed;
  const swatch = [ACCENT, WARN, COOL, "#6E8FA8", "#A88B6E"];

  return (
    <div style={{ border: `1px solid ${EDGE}`, borderRadius: 14, background: CARD, padding: 18 }}>
      <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: TRACK }}>
        {rows.map((r, i) => (
          <div
            key={r.id}
            style={{ width: `${((r.mtd_usd ?? 0) / invoice) * 100}%`, background: swatch[i % swatch.length] }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 11.5, color: MUTED }}>
        <span>ledger explains {Math.round(cov.pct * 100)}% of the invoice</span>
        <span style={MONO}>{usd(cov.unattributed)} unattributed</span>
      </div>
      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        {rows.map((r, i) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: swatch[i % swatch.length] }} />
            <span style={{ flex: 1, ...CLIP }}>{r.name.replace(/^measured · /, "")}</span>
            <span style={{ ...MONO, color: INK_2 }}>{usd(r.mtd_usd)}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${EDGE}`, fontSize: 11.5, color: DIM }}>
        Not extra spend — a breakdown inside the {usd(invoice)} invoice above.
      </div>
    </div>
  );
}

function Chip({ name, need }: { name: string; need: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        border: "1px dashed #3A322E",
        borderRadius: 999,
        fontSize: 12,
        color: "#9A9088",
        background: "#1A1615",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4A413C" }} />
      <span>{name}</span>
      <span style={{ color: FAINT }}>{need}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "16px 18px", fontSize: 12.5, color: DIM, lineHeight: 1.6 }}>{children}</div>;
}

/* ── wording ─────────────────────────────────────────────────────────────── */

const resetLabel = (r: Resource) =>
  (r.reset_label ?? "no reset recorded").replace(/^resets /, "").replace(/^does not reset · /, "");

/** One short clause under the name: what kind of ceiling this is. */
function subtitle(r: Resource, j?: Judgement): string {
  // A row with a reading should say what the reading means; only one without
  // needs to explain itself. Leading with "exact reset time known" printed the
  // same clause under four different numbers.
  if (r.used == null) return "no counter wired";
  if (j?.why) return j.why;
  if (!r.reset_label || /does not reset/.test(r.reset_label)) return "no reset, top-up only";
  return "counted";
}

/** Who is doing the counting, which is not always who owns the ceiling. */
function countedBy(r: Resource): string {
  if (r.used == null) return "none";
  if (r.source === r.vendor) return `${r.vendor}'s own API`;
  if (r.source === "ledger") return "app ledger";
  return r.source ?? "unknown";
}

function flowNote(r: Resource): string {
  if (r.source === r.vendor) return `${r.vendor}'s invoice`;
  if (r.source === "ledger") return "app ledger · no vendor connector, this is the money itself";
  return r.reset_label ?? "";
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}
