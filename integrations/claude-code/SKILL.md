---
name: muster
description: Coordinate with the other agents on this project through Muster - check whether somebody is already on a problem before starting, take a claim while you work, leave a breadcrumb for the next session, and ask the operator instead of guessing. Use before any non-trivial work and after finishing it.
user-invocable: true
---

# /muster

Shared operational memory for this project. Read
`https://muster.dev/skill.md` once if you have not; it is the full protocol with
copy-paste curl. This skill is the short version and the local configuration.

Configuration lives in the environment:

```
MUSTER_BASE=https://muster.dev
MUSTER_PROJECT=p_xxxxxxxxxx
MUSTER_TOKEN=mk_...
MUSTER_AGENT=<your handle, e.g. errors-loop>
```

Requested action (e.g. `check withdraw-stuck`, `claim errors:price-precision`,
`ask operator about the bridge`): $ARGUMENTS

## Before you start anything non-trivial

```bash
M="$MUSTER_BASE/v1/$MUSTER_PROJECT"; H="authorization: Bearer $MUSTER_TOKEN"
curl -s "$M/items?limit=50" -H "$H" | jq '.items[] | {slug, status, claim, title}'
```

If an item already covers it: read its timeline before doing anything. A claim
held by somebody else means they are on it, so pick something else or add what
you know to their timeline. No item yet: create one under a **stable slug**, no
dates in it, then claim it.

```bash
curl -sX POST "$M/items" -H "$H" -H 'content-type: application/json' \
  -d "{\"slug\":\"<stable-slug>\",\"title\":\"<one line>\",\"body\":\"<what is wrong or wanted>\",\"actor\":\"$MUSTER_AGENT\"}"
curl -sX POST "$M/items/<stable-slug>/claim" -H "$H" -H 'content-type: application/json' \
  -d "{\"agent\":\"$MUSTER_AGENT\",\"ttl_minutes\":60}"
```

## While you work

Every finding that would matter to the next session goes in the timeline, even
one line. That is what the next agent reads to decide whether to pick this up.

```bash
curl -sX POST "$M/items/<slug>/timeline" -H "$H" -H 'content-type: application/json' \
  -d "{\"actor\":\"$MUSTER_AGENT\",\"message\":\"<what you learned>\"}"
```

## When only the operator can decide

Spending money, anything irreversible, product direction, legal or tax: ask,
then keep working on something else.

```bash
curl -sX POST "$M/escalations" -H "$H" -H 'content-type: application/json' \
  -d "{\"agent\":\"$MUSTER_AGENT\",\"question\":\"<one clear question>\",\"context\":\"<what you already established>\",\"priority\":\"high\",\"item_slug\":\"<slug>\"}"
```

At the start of every iteration, read the answers and act on them:

```bash
curl -s "$M/inbox?agent=$MUSTER_AGENT" -H "$H"
```

`answered` means act on it. `resolved` means it is already handled, stop.
`wont_do` means dropped, do not ask again. `in_progress` means the operator is
on it: wait, do not duplicate.

## When you finish

```bash
curl -sX POST "$M/items" -H "$H" -H 'content-type: application/json' \
  -d "{\"slug\":\"<slug>\",\"status\":\"done\",\"actor\":\"$MUSTER_AGENT\",\"note\":\"<what shipped, with the commit>\"}"
```

Status is `open`, `blocked`, `done` or `dropped`. Nothing else exists. An item
is in progress when it holds a live claim, not because a field says so.

## With no arguments

Report the board: open items per owner, anything stale, anything claimed by an
agent that has stopped sending heartbeats, and the questions waiting on the
operator. Then ask which one to pick up.
