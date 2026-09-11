import { createClient } from "@supabase/supabase-js";

/**
 * One app in the portfolio. `x`/`y` are its position on the board — the map is
 * a spatial layout the operator arranges by hand, not a sorted list, so the
 * coordinates are data and not derived.
 */
export type App = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  x: number;
  y: number;
  stack: string[];
  /** Monthly spend ceiling, in USD. Null means spend is untargeted. */
  budget_usd: number | null;
};

/**
 * Anonymous client. The board is readable by anyone who gets past auth; nothing
 * here is a secret, and keeping the service key out of anything that renders
 * means a mistake in a component cannot leak it.
 */
export function browserClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/** Service-role client. Server only — writes and storage uploads. */
export function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function listApps(): Promise<App[]> {
  const { data, error } = await serviceClient()
    .from("apps")
    .select("id, slug, name, logo_url, x, y, stack, budget_usd")
    .order("created_at");

  if (error) {
    console.error("[apps] list failed", error.message);
    return [];
  }
  return (data ?? []) as App[];
}

export async function getApp(slug: string): Promise<App | null> {
  const { data, error } = await serviceClient()
    .from("apps")
    .select("id, slug, name, logo_url, x, y, stack, budget_usd")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.error("[apps] get failed", error.message);
    return null;
  }
  return (data as App) ?? null;
}

/** A gauge on an app's board. Shapes differ by `kind`; see the app map. */
export type Resource = {
  id: string;
  kind: "metered" | "usage" | "fixed" | "revenue";
  name: string;
  vendor: string;
  unit: string | null;
  used: number | null;
  cap: number | null;
  reset_label: string | null;
  /** When the ceiling refills, when that is knowable. Drives status, not just copy. */
  resets_at: string | null;
  projection: string | null;
  projection_note: string | null;
  status: "ok" | "warn" | "crit" | "neutral" | "unknown";
  mtd_usd: number | null;
  run_rate_usd: number | null;
  spark: number[];
  source: string | null;
  gross_usd: number | null;
  fees_usd: number | null;
  is_sample: boolean;
  sort: number;
};

export async function listResources(appId: string): Promise<Resource[]> {
  const { data, error } = await serviceClient()
    .from("resources")
    .select(
      "id, kind, name, vendor, unit, used, cap, reset_label, resets_at, projection, projection_note, status, mtd_usd, run_rate_usd, spark, source, gross_usd, fees_usd, is_sample, sort",
    )
    .eq("app_id", appId)
    .order("kind")
    .order("sort");

  if (error) {
    console.error("[resources] list failed", error.message);
    return [];
  }
  return (data ?? []) as Resource[];
}

/** A vendor credential attached to an app. The secret never leaves the server. */
export type Connection = {
  id: string;
  vendor: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
};

/** A reading older than this is no longer describing the present. */
const STALE_AFTER_MS = 24 * 3600 * 1000;

export function connectionState(c: Connection): "connected" | "stale" | "error" {
  if (c.status === "error") return "error";
  // A connector that succeeded yesterday and has not run since is not reporting
  // "fine" — it is reporting yesterday, and the board must say which.
  const age = c.last_sync_at ? Date.now() - new Date(c.last_sync_at).getTime() : Infinity;
  return age > STALE_AFTER_MS ? "stale" : "connected";
}

export async function listConnections(appId: string): Promise<Connection[]> {
  const { data, error } = await serviceClient()
    .from("connections")
    .select("id, vendor, status, last_sync_at, last_error")
    .eq("app_id", appId)
    .order("vendor");

  if (error) {
    console.error("[connections] list failed", error.message);
    return [];
  }
  return (data ?? []) as Connection[];
}
