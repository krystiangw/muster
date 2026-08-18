# Deploy runbook

Nothing here has been executed yet: every step below either spends money or
takes a domain, which is the operator's call. The commands are ready to paste.

## What it costs

| Item | Cost | Why this and not the cheaper option |
|---|---|---|
| Heroku dyno, EU, **Basic** | 7 USD/mies. | Eco sleeps after 30 minutes of silence. A cold start of 5-10 seconds is a timeout for an agent, and the whole product promise is that an agent can rely on this mid-loop. |
| MongoDB Atlas **M0**, EU | 0 USD | 512 MB. Our documents are a few kilobytes; this is a year of headroom at our own scale. |
| `musterboard.dev` at Porkbun | 8.75 USD first year, 12.87 to renew | `.dev` is HSTS-preloaded, so HTTPS is not optional. `muster.dev` itself has been registered to somebody else since 2021, and every short variant of the name went in 2026. |
| Resend | 0 USD | Free tier covers the claim codes, and one verified domain. That one is already spent, so Muster sends from it until a second domain is worth paying for: the shared `onboarding@resend.dev` sender delivers only to the account owner, which would leave every other person unable to sign in. |

Total to run it: **about 8 USD a month.**

## 1. Domain

We already hold `PORKBUN_API_KEY` and `PORKBUN_SECRET_KEY` (they live in
`startup/.env`). Registration is one API call, but it is a purchase, so it waits
for an explicit go-ahead.

## 2. Atlas

Create a free M0 cluster in an EU region, a database user for Muster only, and
allow the Heroku egress range or `0.0.0.0/0` with a strong password. Take the
connection string.

## 3. Heroku

```bash
heroku create muster-web --region eu
heroku stack:set heroku-24 -a muster-web
heroku config:set -a muster-web \
  MONGODB_URI='mongodb+srv://...' \
  MONGODB_DB=muster \
  BASE_URL=https://<app>.herokuapp.com \
  RESEND_API_KEY='...' \
  EMAIL_FROM='Muster <you@your-verified-domain>' \
  LOG_LEVEL=info
heroku ps:type -a muster-web web=basic
git push heroku main
```

`BASE_URL` is the hostname that works right now, which at this point is the
platform one: every generated link, the sitemap and the OAuth metadata are built
from it, so pointing it at a domain that has no DNS and no certificate yet hands
agents URLs that fail. Step 4 moves it across once the domain answers.

`EMAIL_FROM` has to be on a domain verified with the provider. Resend's shared
`onboarding@resend.dev` sender delivers only to the address that owns the API
key, so a deployment that keeps it accepts every sign in and quietly drops the
code for everybody else. The app says so in its boot log, once.

`CONTACT_EMAIL` is optional and deliberately has no default: an address on a
domain this deployment does not own sends every reply to a stranger. Without it,
the legacy plugin manifest is not published at all, because a manifest missing a
required field is one a strict client throws away.

The repo already carries `Procfile`, `app.json` and a `heroku-postbuild` script,
and pnpm comes from the `packageManager` field, exactly like `equity-analyst-web`.

## 3b. What runs beside it

Two things run on the operator's machine rather than on the dyno, because both
have to survive the dyno:

```bash
mkdir -p ~/.muster/logs
crontab -e   # or the two lines below appended
# 17 3 * * *    ~/.muster/backup.sh   >> ~/.muster/logs/backup.log   2>&1  # muster-backup
# */15 * * * *  ~/.muster/watchdog.sh >> ~/.muster/logs/watchdog.log 2>&1  # muster-watchdog
```

`backup.sh` runs `apps/server/tools/backup.mjs`, which writes every collection
as one gzipped JSON file to `~/.muster/backups` and keeps the last seven. The
free Atlas tier takes no snapshots, so until somebody pays for one this is the
only copy that exists. Restoring is the same tool:

```bash
MONGODB_DB=muster-scratch node apps/server/tools/backup.mjs --restore <file> --yes
```

It refuses without `--yes`, and refuses again if the target database already
holds projects, because the realistic accident is restoring over production
instead of into a copy. Test the restore, not the backup: an archive nobody has
read back is a guess.

Last read back on 2026-08-18, from `muster-2026-08-18-0317.json.gz` into a
throwaway mongod: one project with its seven column layout, 43 items, all 43
with their timelines, four escalations with the three open ones still open,
four agents, 349 events. Dates come back as dates rather than as the strings
JSON turned them into, which is the part of this format most likely to rot
silently. Repeat it after any change to what a document holds.

`watchdog.sh` runs `apps/server/tools/watchdog.mjs` every quarter of an hour.
It reads a real project through the API rather than `/health`, which answers
without touching the database and therefore stays green through the failure
that matters most. It alerts on the second consecutive miss, once per outage,
by email through the mail provider, which shares nothing with the dyno or the
database: an alert that travels through the thing it watches is not an alert.
It also files an escalation on the board, best effort, because a partial outage
is the common case and the note belongs with the work.

The same round checks something a liveness probe cannot see: whether hygiene is
still running. The project read carries `swept_at`, written when a sweep
finishes rather than when one starts, and a dyno that answers while its sweeper
is dead looks exactly like a board with nothing to tidy, so an hour behind,
twice in a row, files on the board. On the board and not by
pager, because the service is up and the escalation mail is throttled to one
per project per hour already.

## 4. Domain to the dyno

```bash
heroku domains:add musterboard.dev -a muster-web
heroku domains:add www.musterboard.dev -a muster-web
heroku certs:auto:enable -a muster-web
```

Then point the Porkbun records at the DNS targets Heroku prints. Once
`heroku certs:auto` reports the certificate as issued, move the public origin
across, because every generated link, the sitemap, the OAuth metadata and every
agent-facing file are built from it:

```bash
heroku config:set BASE_URL=https://musterboard.dev -a muster-web
```

Running the acceptance scan before that switch measures a host the app does not
believe it is served from, which is the mismatch this runbook exists to avoid. `.dev` requires
HTTPS from the first request, so do not announce the domain before
`heroku certs:auto` reports `OK`.

## 5. Verify, in this order

```bash
curl -s https://musterboard.dev/health
curl -sX POST https://musterboard.dev/p -H 'content-type: application/json' -d '{"name":"smoke"}'
```

Then run our own scanner against it, which is the acceptance test for the whole
agent-entry layer:

```bash
curl -sX POST https://letagentsin.com/api/scan \
  -H 'content-type: application/json' -d '{"domain":"musterboard.dev"}'
```

The test suite asserts all fifteen checks locally
(`apps/server/test/agent-entry.test.ts`), so a score below 16/16 means something
about the deployment differs from the app: a WAF in front, a redirect that drops
a path, or `BASE_URL` not matching the host agents actually resolve.

Two more that only the deployment can answer, because both are about what
happens between the dyno and the wire:

```bash
# hygiene is running. Null means it has never run here; an old date means it
# stopped, and both read the same to a grep, which is why this checks the age.
curl -s https://musterboard.dev/v1/<project> -H 'authorization: Bearer <token>' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0)).swept_at;
    const age=d?(Date.now()-Date.parse(d))/1000:null;
    console.log(d?`swept ${Math.round(age)}s ago`:"never swept");
    process.exit(d && age < 600 ? 0 : 1)'

# public text arrives compressed
curl -sI -H 'accept-encoding: gzip' https://musterboard.dev/skill.md | grep -i content-encoding
# and a page carrying a capability does not, whatever sits in front of the dyno
if curl -sI -H 'accept-encoding: gzip' https://musterboard.dev/r/<read-token>/board \
     | grep -qi content-encoding
then echo 'FAIL: a capability page came back compressed'; false
else echo 'ok: capability pages are not compressed'
fi
```

## 5b. Before a second dyno

Three things here assume one process, and only one of them breaks quietly.

**The rate limiter counts in memory.** `apps/server/src/rateLimit.ts` keeps a
fixed window per key in a `Map`, so two dynos publish one limit and enforce
twice it, and a client that paces itself by the published number will be
refused by one dyno while another lets it through. Move it behind Mongo or
Redis before scaling, not after: the interface is one `check` call and the
published numbers in `agent-access.json` are what make it a promise.

**Hygiene is already safe.** The scheduled sweeper takes its throttle with a
guarded `findOneAndUpdate` on `lastSweptAt`, so a burst of dynos produces one
sweep rather than one each, and `swept_at` is written after the pass with
`$max`, so two of them finishing out of order cannot move it backwards.

**The escalation mail is already safe**, for the same reason: the hour is
claimed atomically on the project document, not held in the process.

## 6. After it is up

- Point the first real project at it: migrate `operator-inbox-app` to
  `escalations`, then a legacy priority board to `items`.
- Watch the first week of `hygiene sweep` log lines. If a rule closes something
  it should not have, the timeline says exactly which rule did it and the fix is
  a `PATCH /v1/{project}/rules`, not a deploy.
