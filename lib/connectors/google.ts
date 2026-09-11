import crypto from "node:crypto";

/**
 * Google Cloud connector — the ceilings, straight from Google.
 *
 * It reads limits, not usage, and that is a constraint rather than a choice:
 * actual quota consumption lives in Cloud Monitoring, which refuses every call
 * on a project with no billing account attached. The YouTube Data API is free
 * and the project has no billing, so the meter is closed to us.
 *
 * What is still worth having is the ceiling itself. Until now the board asserted
 * a 50,000/day YouTube budget from a constant in our own code; this asks Google
 * and gets the number the project is actually held to — including the limits
 * that were raised above default, and the ones that were not.
 */
export type GoogleQuota = {
  /** One entry per daily, per-project ceiling. */
  daily: { name: string; limit: number; isDefault: boolean }[];
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Mint an access token from a service-account key.
 *
 * Hand-rolled rather than via googleapis: the whole exchange is a signed JWT and
 * one POST, and the library would pull a large dependency tree into a build that
 * has no other use for it.
 */
async function accessToken(sa: ServiceAccount): Promise<string> {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;

  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
  });

  const json = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`google token: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json.access_token;
}

type ServiceAccount = { client_email: string; private_key: string; project_id: string };

export function parseServiceAccount(secret: string): ServiceAccount {
  let sa: Partial<ServiceAccount> & { type?: string };
  try {
    sa = JSON.parse(secret);
  } catch {
    throw new Error("paste the whole service-account JSON file");
  }
  if (sa.type !== "service_account" || !sa.private_key || !sa.client_email || !sa.project_id) {
    throw new Error("not a service-account key (need type, private_key, client_email, project_id)");
  }
  return sa as ServiceAccount;
}

/** Daily, per-project quota ceilings for one Google API. */
export async function fetchGoogleQuota(secret: string, service: string): Promise<GoogleQuota> {
  const sa = parseServiceAccount(secret);
  const token = await accessToken(sa);

  const url =
    `https://serviceusage.googleapis.com/v1beta1/projects/${sa.project_id}` +
    `/services/${service}/consumerQuotaMetrics`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`serviceusage ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    metrics?: {
      displayName?: string;
      consumerQuotaLimits?: {
        unit?: string;
        quotaBuckets?: { defaultLimit?: string; effectiveLimit?: string }[];
      }[];
    }[];
  };

  const daily: GoogleQuota["daily"] = [];
  for (const m of json.metrics ?? []) {
    for (const l of m.consumerQuotaLimits ?? []) {
      // Per-minute ceilings are a burst guard, not a budget: they reset before
      // anyone could act on them, so only the daily ones belong on a board whose
      // unit of decision is "what runs out and when".
      if (l.unit !== "1/d/{project}") continue;
      for (const b of l.quotaBuckets ?? []) {
        const limit = Number(b.effectiveLimit ?? b.defaultLimit ?? 0);
        if (!limit) continue;
        daily.push({
          name: m.displayName ?? "Queries",
          limit,
          isDefault: b.effectiveLimit == null || b.effectiveLimit === b.defaultLimit,
        });
      }
    }
  }

  if (!daily.length) throw new Error(`no daily quota limits reported for ${service}`);
  return { daily };
}
