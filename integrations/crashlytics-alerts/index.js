/**
 * Crashlytics alerts, forwarded to the console.
 *
 * This file does not run here. It is deployed into the Firebase project that
 * owns the mobile app, because Crashlytics offers no API to read crash data
 * from outside — the only thing that leaves Firebase on its own is an alert,
 * and an alert is only catchable from inside the project.
 *
 * All of the shape-knowledge lives here on purpose. Firebase names five alerts
 * with five payloads; the console accepts exactly one schema. When the SDK
 * reshapes a payload, this file changes and the route holding the service-role
 * key does not.
 *
 * Deploy:
 *   firebase deploy --only functions:crashlyticsToConsole
 */
const {
  onNewFatalIssuePublished,
  onNewNonfatalIssuePublished,
  onNewAnrIssuePublished,
  onVelocityAlertPublished,
  onRegressionAlertPublished,
} = require("firebase-functions/v2/alerts/crashlytics");
const { defineSecret, defineString } = require("firebase-functions/params");
const { logger } = require("firebase-functions");

const INGEST_SECRET = defineSecret("CONSOLE_INGEST_SECRET");
const CONSOLE_URL = defineString("CONSOLE_URL"); // https://…/api/ingest/crashlytics

async function forward(event, kind, extra = {}) {
  const issue = event.data?.payload?.issue ?? {};
  const body = {
    firebaseAppId: event.appId,
    kind,
    issueId: issue.id ?? `${kind}:unknown`,
    title: issue.title ?? "(untitled issue)",
    subtitle: issue.subtitle ?? null,
    appVersion: issue.appVersion ?? null,
    // Firebase does not label the platform on the alert; the app id does, in
    // its third segment — "1:123:android:abc".
    platform: (event.appId ?? "").split(":")[2] ?? null,
    // event.time is when Firebase raised the alert. Anything the console needs
    // beyond these fields is in `payload`, unedited.
    occurredAt: event.time ?? new Date().toISOString(),
    payload: event.data?.payload ?? null,
    ...extra,
  };

  const res = await fetch(CONSOLE_URL.value(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": INGEST_SECRET.value() },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    // Throwing asks Firebase to retry, which is right for a console that is
    // down or a secret that was rotated. An unmapped app answers 200 with
    // stored:false precisely so it does not retry forever.
    logger.error("console rejected the alert", { status: res.status, text });
    throw new Error(`console answered ${res.status}: ${text}`);
  }
  logger.info("forwarded", { kind, issue: body.issueId, response: text });
}

const opts = { secrets: [INGEST_SECRET] };

exports.crashlyticsToConsole = {
  fatal: onNewFatalIssuePublished(opts, (e) => forward(e, "fatal")),
  nonfatal: onNewNonfatalIssuePublished(opts, (e) => forward(e, "nonfatal")),
  anr: onNewAnrIssuePublished(opts, (e) => forward(e, "anr")),

  // The only alert that carries numbers. Passing them through is what lets the
  // findings panel say how bad it is instead of only that it is bad.
  velocity: onVelocityAlertPublished(opts, (e) =>
    forward(e, "velocity", {
      eventCount: e.data?.payload?.crashCount ?? null,
      crashPercentage: e.data?.payload?.crashPercentage ?? null,
      appVersion: e.data?.payload?.firstVersion ?? null,
    }),
  ),

  regression: onRegressionAlertPublished(opts, (e) =>
    forward(e, "regression", { appVersion: e.data?.payload?.issue?.appVersion ?? null }),
  ),
};
