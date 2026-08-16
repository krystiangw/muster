# Deploy runbook

Nothing here has been executed yet: every step below either spends money or
takes a domain, which is the operator's call. The commands are ready to paste.

## What it costs

| Item | Cost | Why this and not the cheaper option |
|---|---|---|
| Heroku dyno, EU, **Basic** | 7 USD/mies. | Eco sleeps after 30 minutes of silence. A cold start of 5-10 seconds is a timeout for an agent, and the whole product promise is that an agent can rely on this mid-loop. |
| MongoDB Atlas **M0**, EU | 0 USD | 512 MB. Our documents are a few kilobytes; this is a year of headroom at our own scale. |
| `muster.dev` at Porkbun | ~12-15 USD/rok | `.dev` is HSTS-preloaded, so HTTPS is not optional, and the name types cleanly into a curl line. |
| Resend | 0 USD | Free tier covers the claim codes. Domain already verified for our other sends. |

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
  BASE_URL=https://muster.dev \
  RESEND_API_KEY='...' \
  EMAIL_FROM='Muster <hello@muster.dev>' \
  CONTACT_EMAIL=hello@muster.dev \
  LOG_LEVEL=info
heroku ps:type -a muster-web web=basic
git push heroku main
```

The repo already carries `Procfile`, `app.json` and a `heroku-postbuild` script,
and pnpm comes from the `packageManager` field, exactly like `equity-analyst-web`.

## 4. Domain to the dyno

```bash
heroku domains:add muster.dev -a muster-web
heroku domains:add www.muster.dev -a muster-web
heroku certs:auto:enable -a muster-web
```

Then point the Porkbun records at the DNS targets Heroku prints. `.dev` requires
HTTPS from the first request, so do not announce the domain before
`heroku certs:auto` reports `OK`.

## 5. Verify, in this order

```bash
curl -s https://muster.dev/health
curl -sX POST https://muster.dev/p -H 'content-type: application/json' -d '{"name":"smoke"}'
```

Then run our own scanner against it, which is the acceptance test for the whole
agent-entry layer:

```bash
curl -sX POST https://letagentsin.com/api/scan \
  -H 'content-type: application/json' -d '{"domain":"muster.dev"}'
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
