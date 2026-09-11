/**
 * Vercel connector.
 *
 * Reads the team's billing lines from `/v2/teams/{id}`. That object already
 * carries the plan, seat count and price book, so no separate usage call is
 * needed for cost.
 *
 * What it CANNOT give: consumption. Bandwidth, function invocations and image
 * transforms are not exposed on the public API — `/v1/usage` exists but
 * rejects every documented time range, and `invoiceItems` turns out to be the
 * price book rather than the meter. So Vercel contributes a fixed monthly line
 * here and no ceiling gauges, and the app map should not pretend otherwise.
 */
export type VercelBilling = {
  plan: string;
  seats: number;
  seatPriceUsd: number;
  monthlyUsd: number;
  includedAllocationUsd: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export async function fetchVercelBilling(token: string, teamId: string): Promise<VercelBilling> {
  const res = await fetch(`https://api.vercel.com/v2/teams/${teamId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`vercel ${res.status}: ${body.slice(0, 180)}`);
  }

  const json = (await res.json()) as {
    billing?: {
      plan?: string;
      period?: { start?: number; end?: number };
      invoiceItems?: Record<string, { quantity?: number; price?: number }>;
    };
  };

  const b = json.billing ?? {};
  const items = b.invoiceItems ?? {};
  const seats = items.teamSeats?.quantity ?? 0;
  // Prices come back in cents.
  const seatPriceUsd = (items.teamSeats?.price ?? 0) / 100;
  const included = items.includedAllocationUsd?.quantity ?? 0;

  const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);

  return {
    plan: b.plan ?? "unknown",
    seats,
    seatPriceUsd,
    monthlyUsd: seats * seatPriceUsd,
    includedAllocationUsd: included,
    periodStart: iso(b.period?.start),
    periodEnd: iso(b.period?.end),
  };
}
