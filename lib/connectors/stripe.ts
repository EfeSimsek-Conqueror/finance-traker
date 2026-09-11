/**
 * Stripe connector — money in, net of Stripe's cut.
 *
 * Reads balance transactions rather than charges because a charge is what the
 * customer was billed and a balance transaction is what actually landed. The
 * difference is Stripe's fee, and counting gross as revenue overstates the
 * business on every single sale.
 */
export type StripeRevenue = {
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  count: number;
  currency: string;
};

export async function fetchStripeRevenue(secret: string, sinceUnix: number): Promise<StripeRevenue> {
  let gross = 0;
  let fees = 0;
  let net = 0;
  let count = 0;
  let currency = "usd";
  let startingAfter: string | undefined;

  // Paginate: a busy month exceeds one page, and a silently truncated total is
  // worse than no total at all.
  for (let page = 0; page < 20; page++) {
    const url = new URL("https://api.stripe.com/v1/balance_transactions");
    url.searchParams.set("limit", "100");
    url.searchParams.set("created[gte]", String(sinceUnix));
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`stripe ${res.status}: ${body.slice(0, 180)}`);
    }
    const json = (await res.json()) as {
      data: { id: string; type: string; amount: number; fee: number; net: number; currency: string }[];
      has_more: boolean;
    };

    for (const t of json.data) {
      // Only money coming in. Refunds and payouts are separate movements and
      // would double-count or cancel the picture if summed here.
      if (t.type !== "charge" && t.type !== "payment") continue;
      gross += t.amount;
      fees += t.fee;
      net += t.net;
      count++;
      currency = t.currency;
    }

    if (!json.has_more || !json.data.length) break;
    startingAfter = json.data[json.data.length - 1].id;
  }

  return {
    grossUsd: gross / 100,
    feesUsd: fees / 100,
    netUsd: net / 100,
    count,
    currency,
  };
}
