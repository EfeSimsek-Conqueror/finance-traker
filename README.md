# Cloudgeng Finance Tracker

What is running out across the portfolio, and what it costs.

A private console for two people. It reads quota and spend from the vendors an
app actually bills through, and holds one rule above every other: **never show a
number that was not measured.** Where a figure is unknown it says so — a blank,
a badge, a sentence — rather than a plausible zero.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Requires a `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

CONSOLE_USERS=            # comma separated, lower case
CONSOLE_PASSWORD=         # one shared password
AUTH_SECRET=              # 32+ random bytes, hex

CRON_SECRET=              # lets the scheduled sync run without a session
INGEST_SECRET=            # lets Crashlytics alerts in — see integrations/
FAL_KEY=                  # optional: otherwise the fal connection's own key is used
```

## How it is put together

| | |
|---|---|
| `lib/money.ts` | the money authority. `counted()` picks one reading per vendor per bucket, so a vendor's invoice and the app's own ledger for the same spend never add up. |
| `lib/status.ts` | where green and red come from. Time-to-exhaustion first, fullness only as a fallback, and a ceiling that refills before it could run out is never red. |
| `lib/readings.ts` | append-only history. Sparklines and projections need two readings; one value is a level, not a rate. |
| `lib/sources.ts` | the catalogue behind the add flow: what kinds of box an app can have, and what each needs before it will report. One list, read by the dialog and validated against on the server. |
| `lib/connectors/` | one file per vendor. Each reports only what it can see — Google knows the ceilings, the app's ledger knows the usage, and `mergeCeilings` joins them. |
| `lib/ai/` | the assistant: Gemini 2.5 Pro through fal, with tools that read the same code the board renders. `draft.ts` is the one that fills in the add-a-box form — it drafts, a person writes. |
| `lib/findings.ts` | what is wrong right now, derived on every request rather than stored. A findings list that outlives its problem is worse than none. |
| `lib/crashes.ts` | the one reading that is pushed, not fetched. Crashlytics has no read API, so its alerts arrive at `/api/ingest/crashlytics` from a Cloud Function in `integrations/`. Crashes stay out of `resources` — a stability figure must never reach a spend sum. |
| `middleware.ts` | deny by default. Every API route here holds the service-role key. |

## Adding something to an app

On an app's page, **Add a box** asks three questions in the same order every
time: what kind of box this is, what it is, and what it needs to work.

**Add with the assistant** sits above that list: describe the thing in a
sentence and the model fills the form in — it picks the shape, names the row,
and copies any figure out of what you wrote. It drafts and stops. The credential
and the button stay with a person, and the draft arrives with a list of what to
check. A figure may only be transcribed from your own sentence: asked for "our
Cloudflare Pro plan" with no price, it leaves the amount blank rather than
supplying the one it remembers. Each draft costs about half a cent of model
time, reported on screen with the draft.

A vendor box takes a credential — pasted as separate fields, joined the way the
connector expects — and is tried against the vendor before the dialog closes,
so a wrong or under-scoped key is a sentence on screen rather than a blank card
the next morning. A hand-stated box takes no credential and is written with
`source: "manual"`, which the board renders differently on purpose.

## Deploying

Vercel. Set the same variables in project settings, then `vercel --prod`.
`vercel.json` schedules the hourly sync and the daily briefing; both authenticate
with `CRON_SECRET`.
