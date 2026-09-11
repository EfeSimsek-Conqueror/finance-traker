/**
 * RevenueCat connector — store revenue, net of Apple's and Google's cut.
 *
 * The v2 overview metrics endpoint is the only aggregate RevenueCat exposes;
 * everything else is per-customer. Field names are read defensively because
 * the metric set is not a stable contract — a renamed metric should leave the
 * card empty, never crash the sync.
 */
export type RcMetrics = { revenueUsd: number | null; metrics: Record<string, number> };

export async function fetchRevenueCat(secret: string, projectId: string): Promise<RcMetrics> {
  const res = await fetch(
    `https://api.revenuecat.com/v2/projects/${projectId}/metrics/overview`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`revenuecat ${res.status}: ${body.slice(0, 180)}`);
  }

  const json = (await res.json()) as { metrics?: { id?: string; value?: number; unit?: string }[] };
  const metrics: Record<string, number> = {};
  for (const m of json.metrics ?? []) {
    if (m.id && typeof m.value === "number") metrics[m.id] = m.value;
  }

  // Prefer a 28-day revenue metric when present; fall back to any revenue-ish id.
  const key =
    Object.keys(metrics).find((k) => /revenue/i.test(k) && /28/.test(k)) ??
    Object.keys(metrics).find((k) => /revenue/i.test(k));

  return { revenueUsd: key ? metrics[key] : null, metrics };
}
