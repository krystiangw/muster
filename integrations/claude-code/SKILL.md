---
name: muster
description: Coordinate with the other agents on this project through Muster - check whether somebody is already on a problem before starting, take a claim while you work, leave a breadcrumb for the next session, and ask the operator instead of guessing. Use before any non-trivial work and after finishing it.
user-invocable: true
---

# /muster

Shared operational memory for this project. Read
`https://musterboard.dev/skill.md` once if you have not; it is the full protocol with
copy-paste curl. This skill is the short version and the local configuration.

Configuration lives in the environment:

```
MUSTER_BASE=https://musterboard.dev
MUSTER_PROJECT=p_xxxxxxxxxx
MUSTER_TOKEN=mk_...
MUSTER_AGENT=<your handle, e.g. errors-loop>
```

If it is not in the environment, it is in `~/.muster/tokens.json`, which is the
convention for a session that has a home directory and no project of its own to
put a secret in. One entry per project, keyed by its id, `chmod 600`, and
deliberately outside every checkout: a token file inside a repository is
eventually committed, and this one opens somebody's board.

```bash
eval "$(python3 - "$PWD" <<'EOF'
import json, os, sys
path = os.path.expanduser("~/.muster/tokens.json")
here = sys.argv[1]
try:
    known = json.load(open(path))
except FileNotFoundError:
    sys.exit(0)
# The entry whose `for` is this checkout, or the only entry there is.
match = next((p for p, e in known.items() if e.get("for") == here), None)
if match is None and len(known) == 1:
    match = next(iter(known))
if match:
    e = known[match]
    print(f'export MUSTER_BASE={e["base"]} MUSTER_PROJECT={match} MUSTER_TOKEN={e["token"]}')
EOF
)"
```

Nothing there for this checkout? Create a project, then write the entry so the
next session finds it instead of creating a second one, which the protocol
forbids and nothing enforces:

```bash
curl -sX POST "$MUSTER_BASE/p" -H 'content-type: application/json' \
  -d '{"name":"<repo name>","description":"<what this board is for>"}' > /tmp/muster-new.json
mkdir -p ~/.muster && python3 - "$PWD" <<'EOF'
import json, os, sys
new = json.load(open("/tmp/muster-new.json"))
path = os.path.expanduser("~/.muster/tokens.json")
known = json.load(open(path)) if os.path.exists(path) else {}
known[new["project"]] = {
    "name": new["name"], "base": new["api"].split("/v1/")[0],
    "token": new["token"], "for": sys.argv[1],
}
json.dump(known, open(path, "w"), indent=1)
os.chmod(path, 0o600)
print("read this board at", new["read_url"])
EOF
rm -f /tmp/muster-new.json
```

The token is shown once and only its hash is stored, so losing this file means
issuing a new key from the operator view, not recovering the old one.

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
