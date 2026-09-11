import { serviceClient } from "@/lib/apps";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@/lib/status";

/**
 * The numbers behind the colours, kept in the database rather than the source.
 *
 * The point is that an operator can retune what counts as trouble — and move a
 * card, and set a budget — without a deploy and without anyone holding an editor
 * open. The console has to be usable by the people who run it, not only by
 * whoever last built it.
 */
export async function loadThresholds(): Promise<Thresholds> {
  const { data, error } = await serviceClient()
    .from("settings")
    .select("*")
    .eq("id", "global")
    .maybeSingle();

  // Defaults on any failure: a board that renders with standard thresholds is
  // far better than one that will not render because a settings row is missing.
  if (error || !data) return DEFAULT_THRESHOLDS;

  return {
    ceiling_crit_hours: num(data.ceiling_crit_hours, DEFAULT_THRESHOLDS.ceiling_crit_hours),
    ceiling_warn_hours: num(data.ceiling_warn_hours, DEFAULT_THRESHOLDS.ceiling_warn_hours),
    ceiling_crit_pct: num(data.ceiling_crit_pct, DEFAULT_THRESHOLDS.ceiling_crit_pct),
    ceiling_warn_pct: num(data.ceiling_warn_pct, DEFAULT_THRESHOLDS.ceiling_warn_pct),
    budget_crit_pct: num(data.budget_crit_pct, DEFAULT_THRESHOLDS.budget_crit_pct),
    budget_warn_pct: num(data.budget_warn_pct, DEFAULT_THRESHOLDS.budget_warn_pct),
  };
}

export async function saveThresholds(patch: Partial<Thresholds>): Promise<Thresholds> {
  const current = await loadThresholds();
  const next = { ...current, ...clean(patch) };

  // Crit must be at least as urgent as warn, or a resource can pass straight
  // from green to red and the amber band silently stops existing.
  if (next.ceiling_crit_hours > next.ceiling_warn_hours) {
    next.ceiling_warn_hours = next.ceiling_crit_hours;
  }
  if (next.ceiling_crit_pct < next.ceiling_warn_pct) {
    next.ceiling_warn_pct = next.ceiling_crit_pct;
  }
  if (next.budget_crit_pct < next.budget_warn_pct) {
    next.budget_warn_pct = next.budget_crit_pct;
  }

  // Checked, because the caller is told the board has been retuned. An upsert
  // with an unknown key fails and, unexamined, returned 200 with the new values
  // while the board went on colouring by the old ones.
  const { error } = await serviceClient()
    .from("settings")
    .upsert({ id: "global", ...next, updated_at: new Date().toISOString() });
  if (error) throw new Error(`could not save thresholds: ${error.message}`);
  return next;
}

/** Where the operator dragged each node. Board coordinates, not screen. */
export type NodePlacement = { x: number; y: number; w: number | null; h: number | null };

export async function loadLayout(appId: string): Promise<Record<string, NodePlacement>> {
  const { data } = await serviceClient()
    .from("node_layout")
    .select("node_key, x, y, w, h")
    .eq("app_id", appId);

  const out: Record<string, NodePlacement> = {};
  for (const row of data ?? []) {
    out[row.node_key] = {
      x: Number(row.x),
      y: Number(row.y),
      w: row.w == null ? null : Number(row.w),
      h: row.h == null ? null : Number(row.h),
    };
  }
  return out;
}

export async function saveNode(
  appId: string,
  nodeKey: string,
  place: Partial<NodePlacement>,
): Promise<void> {
  const existing = (await loadLayout(appId))[nodeKey];
  const merged = { ...(existing ?? { x: 0, y: 0, w: null, h: null }), ...clean(place) };
  const { error } = await serviceClient()
    .from("node_layout")
    .upsert({ app_id: appId, node_key: nodeKey, ...merged, updated_at: new Date().toISOString() });
  if (error) throw new Error(`could not save placement: ${error.message}`);
}

/** Forget a node's placement so it returns to where the layout puts it. */
export async function resetLayout(appId: string, nodeKey?: string): Promise<void> {
  let q = serviceClient().from("node_layout").delete().eq("app_id", appId);
  if (nodeKey) q = q.eq("node_key", nodeKey);
  const { error } = await q;
  if (error) throw new Error(`could not reset layout: ${error.message}`);
}

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Drop keys whose value is not a usable number, so one bad field cannot wipe a row. */
function clean<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { out[k] = null; continue; }
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out as Partial<T>;
}
