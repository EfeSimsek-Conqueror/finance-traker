/**
 * fal connector.
 *
 * Reads the workspace's real spend from fal's usage API and writes it back as a
 * pay-as-you-go resource. This is the one vendor where our number and theirs
 * can be checked against each other — every fal response carries `usage.cost`
 * in USD, and this endpoint is the same figure from the billing side.
 *
 * Needs an ADMIN-scope key; an ordinary API key returns 403 here.
 */
export type FalUsage = { totalUsd: number; endpoints: { id: string; usd: number }[] };

/**
 * Credit left on the account, in USD.
 *
 * Lives on `rest.alpha.fal.ai`, not the documented `api.fal.ai` — every
 * balance-shaped path under api.fal.ai 404s, and this one is a genuine leaf
 * (its sibling nonsense paths 404 cleanly while it 401s). It answers with a
 * bare number, no envelope, so there is no field name to depend on.
 *
 * Being on an "alpha" host, it can move without notice; a failure here must not
 * take the spend reading down with it.
 */
export async function fetchFalBalance(adminKey: string): Promise<number | null> {
  try {
    const res = await fetch("https://rest.alpha.fal.ai/billing/user_balance", {
      headers: { Authorization: `Key ${adminKey}` },
    });
    if (!res.ok) return null;
    const value = Number((await res.text()).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export async function fetchFalUsage(adminKey: string, sinceIso: string): Promise<FalUsage> {
  const url = new URL("https://api.fal.ai/v1/models/usage");
  url.searchParams.set("start", sinceIso);
  url.searchParams.set("timeframe", "month");
  url.searchParams.set("expand", "summary");

  const res = await fetch(url, { headers: { Authorization: `Key ${adminKey}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fal usage ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    summary?: { endpoint_id?: string; cost_total?: number }[];
  };
  const endpoints = (json.summary ?? []).map((s) => ({
    id: s.endpoint_id ?? "unknown",
    usd: Number(s.cost_total ?? 0),
  }));
  return { totalUsd: endpoints.reduce((t, e) => t + e.usd, 0), endpoints };
}
