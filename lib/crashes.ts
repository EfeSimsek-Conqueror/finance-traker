import { serviceClient } from "@/lib/apps";

/**
 * What Crashlytics can tell us, in the console's own terms.
 *
 * Firebase names five alerts; these are the four that assert something new is
 * wrong. The stability digest is deliberately not here — it is a weekly summary
 * of issues we were already told about, and importing it would double-count
 * every fatal into the same list twice.
 */
export type CrashKind = "fatal" | "nonfatal" | "anr" | "velocity" | "regression";

export type CrashEvent = {
  id: string;
  source: string;
  kind: CrashKind;
  issue_id: string;
  title: string;
  subtitle: string | null;
  app_version: string | null;
  platform: string | null;
  event_count: number | null;
  user_count: number | null;
  crash_percentage: number | null;
  issue_url: string | null;
  occurred_at: string;
};

/** The shape the webhook accepts. Anything else is rejected, loudly. */
export type IncomingCrash = {
  /** Firebase's app id — "1:123:android:abc". How we find the board it belongs to. */
  firebaseAppId?: string;
  /** Escape hatch for a hand-sent payload, or an app not yet mapped. */
  slug?: string;
  kind: CrashKind;
  issueId: string;
  title: string;
  subtitle?: string | null;
  appVersion?: string | null;
  platform?: string | null;
  eventCount?: number | null;
  userCount?: number | null;
  crashPercentage?: number | null;
  issueUrl?: string | null;
  occurredAt?: string | null;
  payload?: unknown;
};

const KINDS: CrashKind[] = ["fatal", "nonfatal", "anr", "velocity", "regression"];

/**
 * Validate a webhook body without trusting any of it.
 *
 * The sender is a Cloud Function we wrote, but it runs in someone else's
 * project and reaches a route holding the service-role key. A body that half
 * parses is worse than one that is refused: it writes a crash with no title
 * onto a board whose whole claim is that its rows were measured.
 */
export function parseIncoming(body: unknown): { ok: true; crash: IncomingCrash } | { ok: false; why: string } {
  if (!body || typeof body !== "object") return { ok: false, why: "body is not an object" };
  const b = body as Record<string, unknown>;

  const kind = String(b.kind ?? "");
  if (!KINDS.includes(kind as CrashKind)) return { ok: false, why: `kind must be one of ${KINDS.join(", ")}` };

  const issueId = typeof b.issueId === "string" ? b.issueId.trim() : "";
  if (!issueId) return { ok: false, why: "issueId is required" };

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return { ok: false, why: "title is required" };

  if (typeof b.firebaseAppId !== "string" && typeof b.slug !== "string") {
    return { ok: false, why: "one of firebaseAppId or slug is required" };
  }

  // A time we cannot parse becomes no time rather than a wrong one; the row
  // then falls back to now(), which is at least a fact about the delivery.
  const at = typeof b.occurredAt === "string" ? new Date(b.occurredAt) : null;

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  return {
    ok: true,
    crash: {
      firebaseAppId: typeof b.firebaseAppId === "string" ? b.firebaseAppId : undefined,
      slug: typeof b.slug === "string" ? b.slug : undefined,
      kind: kind as CrashKind,
      issueId,
      title: title.slice(0, 300),
      subtitle: typeof b.subtitle === "string" ? b.subtitle.slice(0, 300) : null,
      appVersion: typeof b.appVersion === "string" ? b.appVersion : null,
      platform: typeof b.platform === "string" ? b.platform : null,
      eventCount: num(b.eventCount),
      userCount: num(b.userCount),
      crashPercentage: num(b.crashPercentage),
      issueUrl: typeof b.issueUrl === "string" ? b.issueUrl : null,
      occurredAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      payload: b.payload ?? body,
    },
  };
}

/** Which board this crash belongs on, or null if nothing claims it. */
export async function resolveApp(crash: IncomingCrash): Promise<{ id: string; slug: string } | null> {
  const db = serviceClient();

  if (crash.firebaseAppId) {
    const { data } = await db
      .from("apps")
      .select("id, slug")
      .contains("firebase_app_ids", [crash.firebaseAppId])
      .maybeSingle();
    if (data) return data as { id: string; slug: string };
  }

  if (crash.slug) {
    const { data } = await db.from("apps").select("id, slug").eq("slug", crash.slug).maybeSingle();
    if (data) return data as { id: string; slug: string };
  }

  return null;
}

/**
 * Write the crash down.
 *
 * Upsert, not insert: Firebase Alerts guarantee at-least-once delivery, so the
 * same velocity alert arriving twice is expected traffic and not a second
 * crash. The dedupe index decides what "the same" means.
 */
export async function recordCrash(appId: string, crash: IncomingCrash): Promise<{ ok: boolean; message: string }> {
  const { error } = await serviceClient()
    .from("crash_events")
    .upsert(
      {
        app_id: appId,
        source: "crashlytics",
        kind: crash.kind,
        issue_id: crash.issueId,
        title: crash.title,
        subtitle: crash.subtitle,
        app_version: crash.appVersion,
        platform: crash.platform,
        firebase_app_id: crash.firebaseAppId ?? null,
        event_count: crash.eventCount,
        user_count: crash.userCount,
        crash_percentage: crash.crashPercentage,
        issue_url: crash.issueUrl,
        occurred_at: crash.occurredAt ?? new Date().toISOString(),
        received_at: new Date().toISOString(),
        payload: crash.payload ?? null,
      },
      { onConflict: "app_id,kind,issue_id,occurred_at", ignoreDuplicates: false },
    );

  if (error) return { ok: false, message: error.message };
  return { ok: true, message: `${crash.kind} · ${crash.title.slice(0, 80)}` };
}

/** Everything heard about this app in the last `days`, newest first. */
export async function listCrashes(appId: string, days = 7): Promise<CrashEvent[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await serviceClient()
    .from("crash_events")
    .select(
      "id, source, kind, issue_id, title, subtitle, app_version, platform, event_count, user_count, crash_percentage, issue_url, occurred_at",
    )
    .eq("app_id", appId)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[crashes] list failed", error.message);
    return [];
  }
  return (data ?? []) as CrashEvent[];
}
