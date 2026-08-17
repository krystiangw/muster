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

### Moving a card

A column that is only a filter leaves agents guessing: they can see a column
called "Monitoring" and still have to work out that it means adding a label. So
a column also declares what belongs in it, in `apply`, and a move does exactly
that. A column that declares nothing gets a conservative reading of its own
filter, which covers the ordinary cases without anybody writing the same thing
twice.

Three properties keep this from becoming a second state machine:

- **A move can only set what an item already has.** Status, labels, owner,
  priority, claim. There is no way to express anything else, so no column can
  invent a state through the back door it was denied at the front.
- **`claimed: true` becomes a claim, not a status.** Moving into "In progress"
  takes the lease, and it is refused with a 409 naming the holder if somebody
  else has it. That is the one distinction the four statuses deliberately do not
  carry, and the move respects it rather than routing around it.
- **The reply says where the card actually landed.** A column can filter on more
  than a move can set (a `source`, a field carried from another system), so the
  item can end up elsewhere. Saying so is the same commitment as reporting
  `unplaced`: the board does not pretend.

### Everybody has a name

"Agent" is not a label on a board that six agents write to. A claim already
carries the handle of whoever holds an item, but most items are held by nobody,
and those were reading as anonymous. `lastActor` is who touched an item last,
set by every ordinary write and by no hygiene write, because a sweep is not
somebody working.

That one field is also what makes the board answerable in two directions.
`owner` is who a piece of work is assigned to; `agent` is who is actually on it,
which is the claim holder or, for an item nobody holds, the last writer. They
are different questions and a board that answers only one of them answers the
wrong one about half the time.

The names on offer are every agent registered in the project, followed by the
names read off the items, in two groups so the difference is visible. A
registered agent is offered before it has written anything, because registering
is an agent saying it is here; a claim that lapsed is a leftover and its holder
is not. Each registered name carries what the agent said it is for, since
`loop-3` is a line number rather than a name, and the list is capped well above
every plan's agent cap, so "all the agents" means all of them. Where a ceiling
does bite, the page says how many it left out: a filter that silently drops
names teaches people the same distrust as one that offers empty ones. And the
name currently being filtered by is always in the list, even when nothing has
work behind it any more, because a control that forgets its own value is worse
than no control.

### A card is a summary, so the preview is the rest

A 230px column cannot hold a real title, and truncating without anywhere to read
the rest is the board hiding what it is about. Clicking a card opens a preview
with the whole title, the description, who holds it, and the recent timeline
with each entry's author.

It is a `:target` panel rather than a dialog. That keeps the no-JavaScript rule
the rest of these pages follow, and it has a second effect worth having: the
preview is a URL, so an operator can send somebody a card.

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


## Durable access, short lived credentials

The operator view began as a link that never expired with the credential in its
path. That is durable in exactly the wrong direction. It survives being pasted
into a chat, written to a log, or handed to the next site through a Referer
header, and it dies the moment somebody loses the email that carried it. Both
halves are backwards.

A session inverts them. Getting back in is an address and six digits, the same
gesture as claiming a project, so access is nearly impossible to lose: you would
have to lose the mailbox. The thing that proves it is a cookie the browser will
not hand to another site, it lasts thirty days, and it appears in no URL at all.

Two costs came with it and both were worth paying. A cookie is ambient
authority, so every operator form carries a CSRF token and the sentence "CSRF
does not apply to this service" stopped being true the moment the first cookie
existed. And a code is a credential with a short life, which means issuing and
redeeming it have to be atomic: the first version read, checked and deleted in
three writes, and a review pointed out that concurrent guesses all saw the same
attempt count. It is one write each now.

The rule the whole layer is built around: **email is additive**. An agent still
creates a project with one anonymous POST and never needs a human. Everything
here is for the person who ends up owning the result, and none of it is a gate
in front of the agent.


## Telemetry that is a log of moments, not of people

Almost everything worth knowing about how this service is used is already in
the collections: how many projects exist, how many were claimed, how much work
was written and finished, how fast questions get answered. Counting those needs
no new writes at all.

One thing is genuinely invisible, and it is the one that says whether the front
door works: somebody reading `skill.md` and deciding not to sign up leaves
nothing behind, and neither does the difference between an agent arriving over
curl, over MCP or through OAuth. So there is a small append-only log of moments
and nothing else.

What it holds is the whole design: a kind, a door, one of our own file names,
and a project id where the moment is about a project. No address, no token, no
request body, no user agent, no IP. It expires after ninety days, which is long
enough to see a trend and short enough that it never becomes a second copy of
the service's data. A test asserts the exact set of fields, so widening it is a
decision somebody has to make on purpose.

Two smaller choices worth keeping:

- **Recording can never fail a request.** Every write is fire and forget with
  its own catch. Telemetry that breaks the thing it measures is worse than no
  telemetry.
- **It is a terminal command, not a page.** This is the operator of the service
  looking at their own service rather than a feature of it, and serving it would
  mean minting another credential to protect, on a product whose security notes
  are mostly about how few of those there should be.
