-- Crash reports for the board.
--
-- Deliberately not in `resources`: that table is under the money authority in
-- lib/money.ts, where counted() picks one reading per vendor per bucket and
-- costMtd() sums what it finds. A crash is neither a ceiling nor a charge, and
-- letting it near those sums is how a stability number ends up inside a
-- spend figure. Crashes are events with a time, not gauges with a level.

create table if not exists crash_events (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps(id) on delete cascade,

  -- Which service reported it. Crashlytics today; Sentry would land here too.
  source text not null default 'crashlytics',

  -- What Firebase actually told us. The three alert kinds are different claims:
  -- a new issue is "this started happening", velocity is "this is happening a
  -- lot", regression is "you marked this closed and it came back".
  kind text not null check (kind in ('fatal', 'nonfatal', 'anr', 'velocity', 'regression')),

  issue_id text not null,
  title text not null,
  subtitle text,
  app_version text,
  platform text,
  firebase_app_id text,

  -- Only velocity alerts carry counts. Null means Firebase did not say, which
  -- is not the same as zero and must never render as one.
  event_count integer,
  user_count integer,
  crash_percentage numeric,

  issue_url text,

  -- When Firebase says it happened, and when we heard. They differ, and a
  -- webhook that was down for an hour should be visible as the gap it was.
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),

  payload jsonb
);

-- Firebase Alerts deliver at least once, so the same alert can arrive twice.
-- Upserting on this key makes a redelivery a no-op instead of a second crash.
create unique index if not exists crash_events_dedupe
  on crash_events (app_id, kind, issue_id, occurred_at);

create index if not exists crash_events_recent
  on crash_events (app_id, occurred_at desc);

-- Which Firebase apps belong to which app on the board. An array because one
-- product ships an iOS and an Android app and both report to the same card.
alter table apps add column if not exists firebase_app_ids text[] not null default '{}';

-- No policies: the service role bypasses RLS and nothing else should read this.
alter table crash_events enable row level security;
