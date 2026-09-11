/**
 * The catalogue of things that can be attached to an app.
 *
 * One list, read by both halves of the add flow: the dialog renders it, and the
 * server validates against it. Adding a box to an app is always the same three
 * questions in the same order — what kind of thing is this, what is it called,
 * and what does it need in order to report — and the only way that stays true
 * for a vendor written six months from now is if the questions are data.
 *
 * Deliberately free of imports. It is read by a client component, and a single
 * server-side import here would pull the service-role key into the bundle.
 */

/** One part of a credential. Several parts are joined with "|", in order. */
export type SecretField = {
  key: string;
  label: string;
  placeholder: string;
  /** Rendered as a textarea. For the one credential that is a whole file. */
  multiline?: boolean;
};

/** A vendor this build can actually read. The box fills itself in, on a schedule. */
export type VendorSource = {
  id: string;
  label: string;
  /** What appears on the board once it syncs. Written as a promise to check. */
  reports: string;
  /** Where the credential comes from, and what it has to be scoped to. */
  where: string;
  /** In the connector's own order — `secret` is these joined with "|". */
  fields: SecretField[];
  /** A server environment variable that is part of this vendor's story. */
  env?: { name: string; what: string };
};

/**
 * Every vendor has its own idea of what a credential is, and two of them want
 * an id pasted alongside the key because one key can see several accounts. That
 * used to be the operator's problem — the hint said `<token>|<team id>` and you
 * typed the bar yourself. Here it is two fields, joined on the way out.
 */
export const VENDORS: VendorSource[] = [
  {
    id: "fal.ai",
    label: "fal.ai",
    reports: "spend per endpoint this month, and what is left of the credit pot",
    where: "fal.ai/dashboard/keys — must be ADMIN scope; an ordinary key gets 403 on usage",
    fields: [{ key: "key", label: "Admin key", placeholder: "fal_…" }],
    env: {
      name: "FAL_KEY",
      what: "the assistant's own model calls use this; the connector always uses the key pasted here",
    },
  },
  {
    id: "stripe",
    label: "Stripe",
    reports: "revenue this month, net of fees — and $0.00 when there are genuinely no charges",
    where: "Dashboard → Developers → API keys. A test-mode key reports test-mode money, honestly labelled",
    fields: [{ key: "secret", label: "Secret key", placeholder: "sk_live_… or sk_test_…" }],
  },
  {
    id: "vercel",
    label: "Vercel",
    reports: "the plan and its seats, as a fixed monthly line",
    where: "vercel.com/account/tokens for the token; the team id is on the team's settings page",
    fields: [
      { key: "token", label: "Account token", placeholder: "vercel token" },
      { key: "teamId", label: "Team id", placeholder: "team_…" },
    ],
  },
  {
    id: "ledger",
    label: "The app's own ledger",
    reports: "measured cost per operation, and the API calls the app counted itself",
    where: "the app's own Supabase project → Settings → API. Needs the ai_usage_events or youtube_api_usage table",
    fields: [
      { key: "ref", label: "Project ref", placeholder: "abcdefghijklmnop" },
      { key: "key", label: "Service role key", placeholder: "eyJ…" },
    ],
  },
  {
    id: "revenuecat",
    label: "RevenueCat",
    reports: "App Store and Play revenue over the trailing 28 days",
    where: "RevenueCat → Project settings → API keys (v2 secret). The project id scopes every call",
    fields: [
      { key: "key", label: "v2 secret key", placeholder: "sk_…" },
      { key: "projectId", label: "Project id", placeholder: "proj…" },
    ],
  },
  {
    id: "google",
    label: "Google Cloud",
    reports: "the YouTube API daily ceilings — the limits only; Google will not report usage without billing",
    where: "the whole service-account JSON file, pasted. Needs the Service Usage Consumer role",
    fields: [
      {
        key: "json",
        label: "Service account JSON",
        placeholder: '{ "type": "service_account", … }',
        multiline: true,
      },
    ],
  },
];

export const vendorById = (id: string) => VENDORS.find((v) => v.id === id);

/**
 * The shapes a hand-stated box can take.
 *
 * Four, because the board renders four and no more: a ceiling, a flow, a fixed
 * line, and money coming in. Anything stated here is written with `source:
 * "manual"` and the board says so in the row — a figure someone typed is not
 * the same kind of fact as one a vendor answered with, and the day the two look
 * alike is the day this console stops being worth opening.
 */
export type ManualKind = "fixed" | "revenue" | "metered" | "usage";

export type ManualSpec = {
  kind: ManualKind;
  label: string;
  /** What this shape is for, in the operator's terms. */
  reports: string;
  /** Which numeric fields the dialog asks for. */
  asks: ("monthly" | "ceiling")[];
};

export const MANUAL: ManualSpec[] = [
  {
    kind: "fixed",
    label: "Fixed monthly cost",
    reports: "a subscription that bills the same amount whatever happens — lands under Fixed",
    asks: ["monthly"],
  },
  {
    kind: "usage",
    label: "Metered spend",
    reports: "money that moves with use and has no ceiling — lands under Flow",
    asks: ["monthly"],
  },
  {
    kind: "metered",
    label: "Ceiling",
    reports: "something that runs out. Leave the reading blank and the board shows ? / cap rather than a zero",
    asks: ["ceiling"],
  },
  {
    kind: "revenue",
    label: "Revenue",
    reports: "money in that no connector reports — lands under Revenue and into the margin",
    asks: ["monthly"],
  },
];

export const manualByKind = (kind: string) => MANUAL.find((m) => m.kind === kind);
