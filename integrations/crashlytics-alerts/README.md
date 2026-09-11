# Crashlytics → the console

Crashlytics has no API that will hand over crash data. Its alerts are the only
thing that leaves Firebase on its own, so the board is pushed to rather than
polling — the one reading here that works that way.

## Once, in Supabase

Run `supabase/crashlytics.sql`, then map each Firebase app to its board:

```sql
update apps
   set firebase_app_ids = array['1:123456789:android:abc', '1:123456789:ios:def']
 where slug = 'your-app';
```

The id is in Firebase console → Project settings → Your apps → App ID. Both
platforms can point at one board; the crash row records which one reported.

## Once, in this project

```
INGEST_SECRET=   # 32+ random bytes, hex. Not CRON_SECRET — this one is handed
                 # to a Firebase project, and should not also trigger a sync.
```

Locally in `.env.local`, and in Vercel project settings for production.

## In the Firebase project

`index.js` deploys into the Firebase project that owns the app — not here.
Copy it into that project's `functions/`, then:

```bash
firebase functions:secrets:set CONSOLE_INGEST_SECRET   # paste INGEST_SECRET
firebase functions:config:set                          # or set CONSOLE_URL as a param:
echo 'CONSOLE_URL=https://<the console>/api/ingest/crashlytics' >> functions/.env
firebase deploy --only functions:crashlyticsToConsole
```

Needs the Blaze plan (2nd-gen functions) and Crashlytics alerts enabled in
Firebase console → Alerts.

## Checking it without waiting for a crash

```bash
curl -X POST https://<the console>/api/ingest/crashlytics \
  -H 'content-type: application/json' \
  -H "x-ingest-secret: $INGEST_SECRET" \
  -d '{"slug":"your-app","kind":"velocity","issueId":"test-1",
       "title":"NullPointerException in FeedViewModel",
       "appVersion":"2.3.1","platform":"android",
       "crashPercentage":4.2,"userCount":118}'
```

`{"ok":true,"stored":true,…}` means it landed; the findings panel picks it up on
the next load. `stored:false` with `reason:"no app maps this firebase app id"`
means the `firebase_app_ids` update above has not been run for that app.
