# Walking in as a stranger, 2026-08-19

An agent was pointed at the deployed service with one question: what would go
wrong on the first day if this were announced publicly. It arrived twice, once
with an agent and once with a browser, followed only what the site itself
tells a newcomer, and measured production rather than reasoning from this
repository. It filed nothing and changed nothing; what follows is what it
found, what shipped in `1f3a967` through `8cc841f`, and what was deliberately
left for the operator.

Its own summary of the product is worth keeping, because it is the part that
does not turn into a task: the protocol document, the hygiene engine, the
refusal messages and the honesty of the pricing page are better than the
category norm, and every blocker below was hours of work rather than weeks.

## What a stranger met, and what shipped

**A GET on `/mcp` answered 200 where the protocol says 405.** The official SDK
opens a standalone GET with `accept: text/event-stream`; it read our friendly
info card as a stream that had closed and reconnected, measured at 0.9 requests
a second from a client sitting completely idle. Eighty thousand a day, each,
unmetered, and growing with adoption rather than with traffic: a few hundred
people adding the server to a desktop client would have saturated one dyno with
noise. The card still answers a person who pasted the URL into a browser; a
client asking for a stream is told there is none.

**A body the caller wrote wrong answered 500 "Something broke on our side".**
On the first call a stranger makes, and 5xx is the one class this protocol
tells an agent to retry, so a permanently malformed request became a loop and
every typo landed in our own log as an unhandled error. Only the parser's two
failures answer `bad_json` now; a body over the limit keeps its own 413.

**A question filed on a board nobody owns reached nobody, and the answer said
to wait.** Every board an agent makes starts unclaimed, and the notice needs an
owner's address, so an agent doing exactly what the protocol asks waited for an
answer that had no way of arriving. Both doors now say which situation it is in
and what to do about the second one.

**One page view was one database operation** against a hundred-a-second ceiling
on the cluster this runs on. The failure shape was the worst available: these
writes are never awaited and the API's are, so the marketing site would have
stayed green while the product answered 500. Batched, a hundred views cost two
or three operations, and the buffer is keyed by database because a test file
builds several.

**A field this service does not have was deleted rather than refused.** The
framework strips unknown properties by default, so `POST /keys` with `label`
made a key called "unnamed" and answered 201, and an upsert with a misspelled
field wrote the card without it and reported success. The published promise is
the opposite in as many words. Turning the stripping off found the bug it had
been hiding: `POST /items/<slug>/move` declares `actor`, our own MCP tool for
the same move takes `agent`, so a move made by an agent was recorded as made by
nobody. The route takes both now, and the refusal names the field and lists the
ones that call does take, down to the nested object that actually refused.

**Smaller, and all the same kind of thing.** The handshake confirmed whatever
protocol revision it was sent, including invented ones; it answers with one it
speaks, and no longer claims `2024-11-05`, whose transport this route does not
serve. Six different rate limits said one sentence; each names its bucket, so
an agent told to slow down on writes has no reason to stop reading. The landing
page called an FSL licence "open" while the pricing page had it right. The
contact address was published to machines and to nobody else. The MCP tool
answered with less about a new board than the HTTP door did, and nothing
anywhere said how a token reaches a client that reads its headers once from a
configuration file.

## Left for the operator, with the reason

- **The announcement itself.** Reputationally it is the one thing that does not
  reverse: the slot is spent once, and the audience most likely to appreciate
  this is the one least likely to come back after meeting a tool that
  reconnect-floods its own dyno.
- **`npm publish` for the client and the MCP registry entry.** Both are public
  releases under names claimed permanently. Everything up to the command is
  done, including a key and a live proof endpoint.
- **The database tier and a deploy freeze.** The free cluster takes no
  snapshots, the backup and the watchdog run from a laptop, and one Basic dyno
  has no preboot, so a deploy during the window drops live connections. Money
  and operational risk, therefore not ours.
- **`/privacy` and `/terms`.** Legal.

## What was measured, so the next reading has something to compare against

Throughput on one Basic dyno, keep-alive, one client: 163 requests a second at
concurrency 20, 193 at 30, 203 at 60, with p99 climbing from 541 ms to 1049 ms.
No errors and no 503s: the dyno queues rather than drops, and it saturates a
single Node thread rather than anything else. The database ceiling is reached
first, which is why the telemetry batching was the fix that mattered rather
than anything about the limiter, whose in-memory counting is correct for one
dyno and costs about 25 MB per hundred thousand unique signup addresses.
