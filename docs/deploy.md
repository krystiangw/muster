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

## 6. After it is up

- Point the first real project at it: migrate `operator-inbox-app` to
  `escalations`, then a legacy priority board to `items`.
- Watch the first week of `hygiene sweep` log lines. If a rule closes something
  it should not have, the timeline says exactly which rule did it and the fix is
  a `PATCH /v1/{project}/rules`, not a deploy.
