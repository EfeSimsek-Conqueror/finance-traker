import { serviceClient } from "@/lib/apps";
import type { Resource } from "@/lib/apps";
import { ratePerHour } from "@/lib/status";

/**
 * The board's memory.
 *
 * `resources` holds only what is true now — each sync replaces its vendor's
 * rows — which is why every sparkline was empty and the YouTube card could only
 * say "needs a second reading to project". A running total is a level, not a
 * rate: one reading can never say how fast anything is moving.
 *
 * Rows are identified by (app, vendor, name) rather than by resource id,
 * because the id is replaced on every sync and the thing being measured is not.
 */
export type Reading = { used: number | null; mtd_usd: number | null; taken_at: string };

/** Append this sync's readings. Failure here must never fail the sync itself. */
export async function record(appId: string, rows: Resource[]): Promise<void> {
  const payload = rows
    .filter((r) => r.used != null || r.mtd_usd != null)
    .map((r) => ({
      app_id: appId,
      vendor: r.vendor,
      name: r.name,
      kind: r.kind,
      unit: r.unit,
      used: r.used,
      cap: r.cap,
      mtd_usd: r.mtd_usd,
    }));
  if (!payload.length) return;

  const { error } = await serviceClient().from("readings").insert(payload);
  // History is a nicety; a sync that wrote fresh numbers and failed to archive
  // them is still a successful sync, and saying otherwise would mark a healthy
  // connector as broken.
  if (error) console.error("[readings] insert failed", error.message);
}

/** Series for one app, newest last, keyed by `${vendor}|${name}`. */
export async function seriesFor(appId: string, sinceDays = 30): Promise<Map<string, Reading[]>> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data } = await serviceClient()
    .from("readings")
    .select("vendor, name, used, mtd_usd, taken_at")
    .eq("app_id", appId)
    .gte("taken_at", since)
    // Newest first with an explicit cap, then reversed below. Ascending with no
    // limit silently hit PostgREST's 1000-row ceiling and returned the OLDEST
    // thousand, so after a few days of syncing every projection froze while
    // still rendering as current — the worst shape a stale number can take.
    .order("taken_at", { ascending: false })
    .limit(4000);

  const out = new Map<string, Reading[]>();
  for (const r of [...(data ?? [])].reverse()) {
    const key = `${r.vendor}|${r.name}`;
    const list = out.get(key) ?? [];
    list.push({ used: r.used, mtd_usd: r.mtd_usd, taken_at: r.taken_at });
    out.set(key, list);
  }
  return out;
}

/**
 * Attach what history makes knowable: a shape, and a time.
 *
 * The projection only replaces a connector's own when the connector did not
 * have one — fal knows its balance and burn directly, and a rate inferred from
 * two of our samples would be a worse answer to the same question.
 */
export function enrich(rows: Resource[], series: Map<string, Reading[]>): Resource[] {
  return rows.map((r) => {
    const history = series.get(`${r.vendor}|${r.name}`) ?? [];
    const spark = sparkFrom(r, history);
    const projected = r.projection == null || /no projection/i.test(r.projection)
      ? projectExhaustion(r, history)
      : null;
    return projected ? { ...r, spark, ...projected } : { ...r, spark };
  });
}

function sparkFrom(r: Resource, history: Reading[]): number[] {
  const pick = (h: Reading) => (r.kind === "metered" ? h.used : h.mtd_usd);
  const values = history.map(pick).filter((v): v is number => v != null);
  // Two points is a line, and a line drawn through two samples taken minutes
  // apart says nothing. Below three, draw nothing.
  return values.length >= 3 ? values.slice(-40) : [];
}

/**
 * When a ceiling will be reached, from the slope between the first and last
 * reading inside the current window.
 */
function projectExhaustion(
  r: Resource,
  history: Reading[],
): { projection: string; projection_note: string; status: Resource["status"] } | null {
  if (r.kind !== "metered" || r.cap == null || r.used == null) return null;

  // The slope lives in lib/status, which is also what colours the card. Two
  // copies of this arithmetic would eventually disagree, and the label and the
  // colour would contradict each other on the same card.
  const rate = ratePerHour(history);
  if (!rate) return null;
  const { perHour, overHours: hours } = rate;
  const left = r.cap - r.used;

  if (perHour <= 0) {
    return {
      projection: "no exhaustion",
      projection_note: `flat or falling over the last ${fmtHours(hours)}`,
      status: "ok",
    };
  }

  const hoursLeft = left / perHour;
  return {
    projection: whenFrom(hoursLeft),
    projection_note: `at ${round(perHour)} ${r.unit ?? "units"}/h over the last ${fmtHours(hours)}`,
    status: hoursLeft < 24 ? "crit" : hoursLeft < 72 ? "warn" : "ok",
  };
}

/** A clock time if it lands today, a date if it does not. */
function whenFrom(hoursLeft: number): string {
  if (hoursLeft > 24 * 90) return "over 90 days";
  const at = new Date(Date.now() + hoursLeft * 3_600_000);
  const sameDay = at.toDateString() === new Date().toDateString();
  if (sameDay) {
    return `runs out ${at.getHours().toString().padStart(2, "0")}:${at
      .getMinutes()
      .toString()
      .padStart(2, "0")} today`;
  }
  if (hoursLeft < 48) return "runs out tomorrow";
  return `runs out ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

const fmtHours = (h: number) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)} days`);
const round = (n: number) => (n >= 10 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
