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
FAL_KEY=                  # optional: otherwise the fal connection's own key is used
```

## How it is put together

| | |
|---|---|
| `lib/money.ts` | the money authority. `counted()` picks one reading per vendor per bucket, so a vendor's invoice and the app's own ledger for the same spend never add up. |
| `lib/status.ts` | where green and red come from. Time-to-exhaustion first, fullness only as a fallback, and a ceiling that refills before it could run out is never red. |
| `lib/readings.ts` | append-only history. Sparklines and projections need two readings; one value is a level, not a rate. |
| `lib/connectors/` | one file per vendor. Each reports only what it can see — Google knows the ceilings, the app's ledger knows the usage, and `mergeCeilings` joins them. |
| `lib/ai/` | the assistant: Gemini 2.5 Pro through fal, with tools that read the same code the board renders. |
| `lib/findings.ts` | what is wrong right now, derived on every request rather than stored. A findings list that outlives its problem is worse than none. |
| `middleware.ts` | deny by default. Every API route here holds the service-role key. |

## Deploying

Vercel. Set the same variables in project settings, then `vercel --prod`.
`vercel.json` schedules the hourly sync and the daily briefing; both authenticate
with `CRON_SECRET`.
