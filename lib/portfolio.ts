import { connectionState, serviceClient, type App, type Resource, type AppSummary } from "@/lib/apps";
import { costMtd, dedupeShared, ghostVendors, mergeCeilings, revenueMtd, usd } from "@/lib/money";
import { applyJudgements, type Thresholds } from "@/lib/status";
import { seriesFor } from "@/lib/readings";

/**
 * Enough for a tile to say something true.
 *
 * The map used to print "NO DATA · 0 near limit · no revenue data" under every
 * app, as literals rather than queries — on a portfolio with six live
 * connectors and $49 measured. It was the first screen anyone saw and it
 * asserted the one thing this console exists not to assert.
 */
export async function summarise(apps: App[], thresholds: Thresholds): Promise<Record<string, AppSummary>> {
  const db = serviceClient();
  const out: Record<string, AppSummary> = {};
  const everything: Resource[] = [];

  await Promise.all(
    apps.map(async (app) => {
      const [{ data: rows }, { data: conns }, series] = await Promise.all([
        db
          .from("resources")
          .select(
            "id, kind, name, vendor, unit, used, cap, reset_label, resets_at, projection, projection_note, status, mtd_usd, run_rate_usd, source, is_sample",
          )
          .eq("app_id", app.id)
          .eq("is_sample", false),
        db.from("connections").select("id, vendor, status, last_sync_at, last_error").eq("app_id", app.id),
        seriesFor(app.id, 3),
      ]);

      const resources = mergeCeilings((rows ?? []) as Resource[]);
      everything.push(...resources);
      const { rows: judged, judgements } = applyJudgements(resources, series, thresholds);

      const gauges = judged.filter((r) => r.kind === "metered" && r.used != null);
      const tones = gauges.map((r) => judgements[r.id]?.tone).filter(Boolean);

      const states = (conns ?? []).map(connectionState);
      const revenueRows = resources.filter((r) => r.kind === "revenue");

      out[app.id] = {
        costMtd: costMtd(resources),
        // Null, not zero, when nothing reports revenue. The two states looked
        // identical on the tile and mean opposite things.
        revenueMtd: revenueRows.length ? revenueMtd(resources) : null,
        nearLimit: tones.filter((t) => t === "warn" || t === "crit").length,
        tone: tones.includes("crit")
          ? "crit"
          : tones.includes("warn")
            ? "warn"
            : gauges.length
              ? "ok"
              : "neutral",
        connected: states.filter((s) => s === "connected").length,
        stale: states.filter((s) => s === "stale").length,
        errored: states.filter((s) => s === "error").length,
        unmeasured: ghostVendors(resources).length,
        measuredRows: resources.length,
        lastSync:
          (conns ?? [])
            .map((c) => c.last_sync_at)
            .filter((v): v is string => v != null)
            .sort()
            .pop() ?? null,
      };
    }),
  );

  return out;
}

/**
 * What the portfolio costs, which is not the sum of the tiles.
 *
 * A Vercel team subscription is attached to both apps, so each tile carries the
 * full $40 — a defensible attribution per app, and plainly wrong added up. The
 * money left the account once.
 */
export async function portfolioCost(apps: App[]): Promise<{ total: number; label: string }> {
  const db = serviceClient();
  const rows: Resource[] = [];

  await Promise.all(
    apps.map(async (app) => {
      const { data } = await db
        .from("resources")
        .select("id, kind, name, vendor, unit, used, cap, mtd_usd, source, is_sample")
        .eq("app_id", app.id)
        .eq("is_sample", false);
      rows.push(...((data ?? []) as Resource[]));
    }),
  );

  const total = costMtd(dedupeShared(rows));
  return { total, label: usd(total) };
}
