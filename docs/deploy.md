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

`SITE_VERIFICATION` is optional too, and its absence is silent: every page
renders without the `google-site-verification` meta tag and nothing says so.
That silence cost an hour once, because a note claimed the tag was live when the
variable had never been set. If you verify a search property with the HTML tag,
set it and check the tag arrived:

```bash
heroku config:set SITE_VERIFICATION='<token from the search console>' -a muster-web
curl -s https://musterboard.dev/ | grep -c google-site-verification   # expect 1
```

Verifying by DNS instead needs nothing from the app: the TXT record on the
domain is the whole method, and `dig +short TXT <domain>` is how to see it.

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

Last read back on 2026-08-18 at 11:28, from `muster-2026-08-18-1128.json.gz`
into a throwaway mongod: four projects, ours with its seven column layout, 75
items, all 75 with their timelines, 15 escalations, 786 documents in 53 kB.
Dates come back as dates rather than as the strings JSON turned them into,
which is the part of this format most likely to rot silently, and that now
includes the two written today: `escalationNoticeSentAt` on a project and
`notifiedAt` on a question. Repeat it after any change to what a document
holds.

`watchdog.sh` runs `apps/server/tools/watchdog.mjs` every quarter of an hour.
It writes one line an hour when everything is fine, naming what it checked and
what each answered, because a log that is empty while it runs and empty while
its cron entry is missing tells a person tailing it nothing. The rest of the
time it says nothing at all.
It reads a real project through the API rather than `/health`, which answers
without touching the database and therefore stays green through the failure
that matters most. It alerts on the second consecutive miss, once per outage,
by email through the mail provider, which shares nothing with the dyno or the
database: an alert that travels through the thing it watches is not an alert.
It also files an escalation on the board, best effort, because a partial outage
is the common case and the note belongs with the work.

The same round posts a form the way a browser does, because every other check
here speaks the way an agent does: a bearer token, no browser headers, and past
the check a browser actually has to pass. On 2026-08-18 our own referrer policy
blanked the `Origin` header, the same-site check read that as a stranger, and
every form on the capability pages answered 403 for a night while both checks
above stayed green. The probe writes nothing: an unknown status word is refused
after the link has been recognised and before anything is answered, so a 400
means the whole path in front of the write is open and a 403 means the forms are
dead again.

It also watches the one thing the whole product is for: that a question reaches
a person. Two dates in the project summary tell apart the two silences that look
identical from a board. The mail is throttled to one message per project per
hour, so a queue waiting its turn has an old `oldest_unannounced_at` and a
recent `notice_sent_at`, because the hourly message keeps moving even while the
back of the queue waits. A mail path refusing every send has both of them old.
Two hours on both, twice in a row, files on the board first and only falls back
to mail, which is the reverse of every other alert here for the obvious reason:
mail is the thing under suspicion.

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

Before a release, and after anything that touches how work is accounted for:

```bash
node tools/soak-local.mjs
```

Thousands of concurrent operations against a server that exists only for the
run, checking what a request-by-request test cannot: that the open counter
matches the collection, that a slug never becomes two items, and that two agents
never hold one claim. It earned its place on 2026-08-18 by finding the counter
drifting below the collection, permanently, because nothing raises a counter
that is too low.

All three of the checks below, in one command, which is what to run after a
deploy:

```bash
node tools/acceptance.mjs
```

Non-zero if any door fails. Each one keeps its own board or client and reuses
it, so this can also be a nightly cron entry without filling the funnel with our
own signups.

And the door that hands out credentials, which is the one where a regression
costs more than a broken page:

```bash
node tools/smoke-oauth.mjs
```

Both metadata documents, a registration refused for asking a grant this server
does not run, a token from `client_credentials`, a write with it, and a wrong
secret refused. It also asserts the repair the audit made: `expires_in` is an
hour or less, because this endpoint used to hand out a key that lived as long
as the project, one per refresh, sixty two of them on one board.

And the door most agents actually arrive through, which no other check here
touches:

```bash
node tools/smoke-mcp.mjs
```

Twelve tools over MCP against the deployment: initialize, the tool list, and a
whole session from registering an agent to filing a question and closing it. The
suite covers the handlers; this covers the transport, whatever sits in front of
it, and the shape of a tool result, where a client reads `structuredContent` or
the text and a tool that filled only one works in one client and breaks in the
next.

And the other half of the promise, which is released separately from this one:

```bash
node tools/smoke-sdk.mjs
```

That installs `musterboard` from the registry into a temporary directory and
drives the deployment through it, thirteen calls, the way an agent that read
`/skill.md` and ran `npm install musterboard` does. Nothing in the suite covers
this: the tests import the package from next door, so a server change that
breaks the published client passes everything and fails the first stranger. It
signs itself up, so it needs no token, and the project it leaves behind is
unclaimed and expires on its own.

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

## 7. Publishing the MCP server to the registry

The one distribution step nobody can do for us, and the only one worth doing
first: Smithery, Glama, mcp.so and MCPfinder all pull from the official
registry, so this is one publication rather than four submissions.

`server.json` in the repository root is the document that gets published. It
names the server `dev.musterboard/muster`, which is a domain namespace and
deliberately not `io.github.<owner>/muster`: the GitHub form ties the identity
to an account name, and renaming the account or moving the repository breaks
the name every client has stored. We own the domain, so the domain is what we
publish under, and the registry grants the whole `dev.musterboard/*` namespace
to whoever proves it.

Proving it is the part that has to be interactive, and that is the point of it.
The commands below are the registry's own, checked against its CLI reference
rather than remembered:

1. Generate an Ed25519 keypair. Keep `key.pem` in `~/.muster/`, chmod 600,
   outside every checkout, like the rest of them.

   macOS ships LibreSSL as `openssl`, and it cannot generate Ed25519 keys at
   all: `genpkey` answers "Algorithm Ed25519 not found". So the binary is named
   once here and used by every command below, rather than mentioned as a
   warning somebody reads after the first one fails.

   ```bash
   SSL="$(brew --prefix openssl@3)/bin/openssl"   # on Linux: SSL=openssl
   "$SSL" genpkey -algorithm Ed25519 -out ~/.muster/mcp-registry-key.pem
   chmod 600 ~/.muster/mcp-registry-key.pem
   ```

2. Build the proof record, which is a whole line and not just the key, and set
   it as `MCP_REGISTRY_AUTH` on the deployment:

   ```bash
   PUBLIC_KEY="$("$SSL" pkey -in ~/.muster/mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
   heroku config:set MCP_REGISTRY_AUTH="v=MCPv1; k=ed25519; p=${PUBLIC_KEY}" -a muster-web
   curl -s https://musterboard.dev/.well-known/mcp-registry-auth
   ```

   That path answers 404 until the variable is set, on purpose.

3. Log in with the HTTP method, which is the one that reads that file. `login
   dns` proves the same thing through a TXT record instead and does not look at
   it at all. The key is passed as hex, not as the PEM:

   ```bash
   PRIVATE_KEY="$("$SSL" pkey -in ~/.muster/mcp-registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
   mcp-publisher login http --domain=musterboard.dev --private-key="${PRIVATE_KEY}"
   ```

4. Check the document, then publish. `validate` is the dry run; `publish` has
   no `--dry-run` and goes straight to the registry:

   ```bash
   mcp-publisher validate server.json
   mcp-publisher publish
   ```

Republish on a version change. `version` in `server.json` is the server's, not
the SDK's; keep it in step with what `/.well-known/mcp.json` reports, because a
registry entry claiming a version the server does not is the kind of drift an
agent finds and nobody else does.
