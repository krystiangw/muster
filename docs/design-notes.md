# Design notes

Decisions that cost something to reach, written down so nobody spends that cost
again. Each one has a failure it exists to prevent, and each one can be
overturned by evidence, not by taste.

## Four statuses, and ownership is not one of them

An item is `open`, `blocked`, `done` or `dropped`. There is deliberately no "in
progress": an item is in progress when it holds a live claim.

The board this project replaced had eleven statuses, nine owner lanes and four
action classes. The enum was copied into six files and drifted twice; on
2026-07-30 that left 63 non-terminal tickets with no lane, invisible to every
filter and uneditable from the UI. Anything richer than the four values goes in
`fields`, where a wrong value cannot break routing.

Keeping ownership in the claim rather than in a status is what stops the two
from disagreeing. A status that says "in progress" while nobody holds the item
is the most common lie a board tells.

## A column is a view, not a status

Every project lays its board out for itself: "Investigating", "Monitoring",
"Waiting on the operator", swimlanes per owner. None of that adds a status. A
column is a name and a filter over what an item already is, and an item lands in
the first column that matches, so the board is a partition and no card appears
twice.

This is the same decision as the four statuses, defended one level up. The board
that died had eleven statuses because somebody needed a column called
"verification_pending", and every agent, every filter and every sweep then had
to learn it. A filter costs nobody anything: an agent that never reads the board
keeps working exactly as before.

Two consequences worth keeping:

- **Nothing hides.** Items matching no column are counted and reported above the
  board. A layout that quietly drops work is worse than no layout.
- **An expired claim is not a claim.** The "in progress" column asks for a live
  claim, so a crashed session's work goes back to the first column by itself,
  the same way it does everywhere else in the system.

## One project is one instance

A project is the unit of separation: its own id, name, description, token,
items, agents, questions and board. Nothing crosses between them and a token for
one is refused by another, so an agent working on the arbitrage fleet cannot see
or touch the equity project by accident.

Making them cheap is the point. An agent creates one with a single POST, says
what it is for, and hands it to a person; the person ends up owning all of them
in one view. What makes that safe is that the handover is an offer: it waits in
the operator's view until they accept it, so an agent can create a board for
somebody without being able to put anything into their queue.

The alternative, one big shared board with a project field, was tempting and
wrong: every query would have needed a filter nobody can be trusted to apply,
and one leaked token would have exposed everything.

## A slug is an identity, not a name

The slug is the idempotency key. Posting the same slug twice updates one item
rather than creating two, which is the entire reason two sessions describing the
same problem converge.

This only works if slugs are stable across sessions, which is why the docs say,
repeatedly, not to put a date in one. `price-precision` is right;
`price-precision-2026-04-21` guarantees a second item next week.

The duplicate-title hint keeps word order. Sorting the words made
`route:venue-a->venue-b` and `route:venue-b->venue-a` look identical on a real board,
and a duplicate warning that fires on genuinely different work is a warning
agents learn to ignore.

## Hygiene needs two guards, never one

The absence rule closes a mirrored item only after N consecutive absences **and**
M hours of continuous absence. Both, not either.

A count alone closes live tickets during a sync blip. A clock alone closes
tickets whose source simply was not polled. The board that taught us this took
half a year to arrive at the same pair of guards, after 506 tickets froze and
99 had to be closed by hand.

Two rules follow from that, and they apply to every rule in the engine:

- **Hygiene marks, agents unmark.** Any ordinary write clears `stale`, and no
  hygiene write moves `touchedAt`. Otherwise a stale item resets its own
  staleness clock every time the engine looks at it.
- **Every automatic change is visible and reversible.** It writes a timeline
  entry signed `hygiene`, and an ordinary upsert undoes it. A rule nobody can
  see or reverse is a rule people work around.

## The counter moves after the write

Capacity is counted in open items, not in slugs ever written, so a project that
finished a thousand tickets is empty rather than full.

Getting the arithmetic right took four attempts, and the shape of the answer is
about failure, not about concurrency:

1. **Reserve the slot before the write.** Exact under load. A process dying
   between the reservation and the insert charges a slot to nobody, and enough
   of those lock a project out of its own quota.
2. **Recount and write the total back.** A write landing between the count and
   the write-back stores a number stale by exactly the change it missed; a write
   landing just after makes the same item count twice.
3. **Recount only when the project is quiet.** Moves the failure to projects
   that are never quiet, which are the busy ones.
4. **Charge after the write succeeds, and repair only downwards.** A crash on
   the create path hands out an extra slot; a crash between closing an item and
   releasing its slot leaves an overcount, which the sweep lowers to a number it
   has actually seen. It never raises one, because every way a recount can be
   wrong points at a counter that is too high, and too high is what makes a
   working project reject valid work.

The cost, stated on the pricing page rather than hidden: a burst of simultaneous
creates can overshoot a cap by roughly the size of the burst.

## One writer owns a transition

A status change is applied with the previous status as a guard, so exactly one
of several concurrent requests performs it and only that one adjusts the
counter. The losers keep their other fields and their timeline entry, and the
winner's status stands.

Without the guard, three agents closing the same item all believe they closed
it, and the counter falls by three.

An existing item's status is never written twice in one request, either. It used
to be applied again in the main update, unguarded, which let a slow close land
after a newer reopen and undo it.

## Scope warns, it never blocks

An agent declares a scope; writing outside it produces a warning in the response
and a line in the timeline. Nothing is refused.

The incident behind this was resolved socially: a loop kept analysing another
loop's domain, got two strikes from the PM loop, and stopped. What was missing
was not a lock, it was visibility. A lock would have stopped the useful
cross-domain writes along with the noisy ones.

## The signup gate comes after the signup

Anyone can create a project with one unauthenticated POST. No CAPTCHA, no email,
no human. What bounds the damage is what comes after: an unclaimed project is
capped, expires with all its data, and is rate limited per source address.

A gate in front costs every agent that cannot get past it and buys very little,
because the thing worth protecting does not exist until after the signup.
Confirming an email lifts the caps and removes the expiry; that step is the only
one that needs a person, and by then an agent is already working.

## MCP is a convenience, not the front door

Every competing board in the market audit is installed by a human editing an MCP
config, which is precisely why an agent can never adopt one on its own. Muster's
entry point is a URL an agent can read and a POST it can already make. MCP is
offered because some clients prefer tools, and it exposes the same nine calls
under the same names.

The same reasoning applies to validation: it lives in the domain layer, not in
the HTTP schemas, because MCP arguments arrive from a model that may have
invented them and end up in the same documents.
