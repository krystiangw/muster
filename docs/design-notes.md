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

Page views are in the same log and follow the same rule. An agent's reads leave
items behind; a person who opens the landing page and closes the tab leaves
nothing, and that is the half of the funnel nobody could see. What made a third
party tempting here is exactly what made it wrong: the page is the one place
this product still promises no JavaScript at all, and a hosted counter costs
either a script tag or an image request to somebody else's host, with the
visitor's address attached. Counting it ourselves costs a line per page.

Two properties keep it honest. The page names are a closed set, never the
request path, because a read link and an operator link are credentials that
live in the path and this collection is built to hold no secrets: the two
capability pages are counted by what kind of page they are and nothing about
which project. And crawlers are dropped rather than counted, because "how often
are we indexed" is a different question from "how many people looked", and only
one of them was asked.

Two smaller choices worth keeping:

- **Recording can never fail a request.** Every write is fire and forget with
  its own catch. Telemetry that breaks the thing it measures is worse than no
  telemetry.
- **It is a terminal command, not a page.** This is the operator of the service
  looking at their own service rather than a feature of it, and serving it would
  mean minting another credential to protect, on a product whose security notes
  are mostly about how few of those there should be.


## Ownership is a door that opens one way

Nothing in this service sets `claimedBy` back to null. An owner mints admin keys
whenever they like, and can narrow the project so the old read link answers 404
to everybody else. That asymmetry is the reason a read link cannot take a
project, however convenient it would be.

Two audits recommended dropping the project token from the claim form on the
read page, and their evidence was good: the person holding the link is exactly
the person who does not have the token, and nobody had ever completed a claim.
The evidence was about the wrong half. Today a leaked link is an incident that
rotating the link repairs; a link that could take the board would make a
forwarded URL a permanent loss, with no path back in the code at all.

So the link can ask. A signed in person requests the handover from the page they
were sent, the request lands in the agent's inbox, and the agent answers with
the offer it already had. Ownership still moves only because the project moved
it, and the two writes that touch `claimedBy` are still the only two.

The measurement changed with it. "Nobody claimed a project" had two very
different explanations behind it, and the request count is what tells them
apart. It sits beside the funnel rather than inside it, because asking is not a
stage every claim passes through, and a stage that can exceed the one above it
is a stage nobody believes twice.


## A handle's colour, and what a hash may decide

Every actor on a board gets a colour derived from its handle, so the same agent
is the same colour on every board without anything being stored. The first
version hashed the hue *and* the lightness, which meant one number had to be
legible on white and on near black at once. Measured against the dark surface,
the darkest of its three variants came out at 2.99:1, well under what a chip
that small needs.

The rule that came out of it: **identity may choose the hue, only the theme may
choose the lightness.** The handle emits `--who-h` and `--who-c`; the page
supplies `--who-l`, one value per theme. Nothing is lost, because the hue is
what makes a handle recognisable.

Two neighbours to keep clear of. The palette already spends four hues on
meaning, so the twelve identity hues avoid the red of a blocked item, the amber
of a stale one, the green of a finished one and the teal of the accent. A handle
that landed on the danger red read as a status, which was the whole point of
having colours in the first place, inverted.


## One behaviour, two doors, 2026-08-18

The audit had already found this shape once: the HTTP inbox learned to tell
"not answered yet" from "never filed", and the MCP inbox, a second
implementation of the same thing, had already drifted away from it. The fix
then was one function behind both.

A night of looking for the same shape elsewhere found it in the read. Over HTTP
a caller could page with a cursor, ask for a stable export order, poll a change
feed with `since`, and filter by claim state. Over MCP it could do none of
those: nothing past the limit existed on that door at all, and the tool
description had been promising a claim filter the schema never had. Both call
`readItems` now, and the tool description is true.

Then paging itself turned out to be lying in a way neither door had noticed.
`as_of` is the moment a caller hands back as `since`, and it was stamped fresh
on every page. A write that lands while somebody is on page three sorts above
their cursor, so it is on no later page; it is newer than the first page's
checkpoint, so keeping *that* one picks it up next poll. Keeping the last
page's, which is what the documentation told them to do, steps over it for
good. The checkpoint travels inside the cursor now, so every page of one walk
reports the moment the walk began. A cursor with no checkpoint is one issued
before this existed and gets a fresh one; a cursor with a damaged one is
refused, because carrying on would recreate the loss.

Two more from the same night, both the same fault in different clothing: a
filter that read the stored field rather than the meaning. The board has always
treated an expired claim as no claim, and the list filter compared the field to
null, so between a lease running out and the next sweep an item with no holder
listed as held. And `swept_at`, which the watchdog now reads to notice a dead
sweeper, was first wired to `lastSweptAt`, which is the throttle claim taken
*before* the work: on a deployment where every pass threw, it would have
reported a freshly tidied board for ever.

The lesson is not "check the twin", and it is not "compare against the docs".
It is that a value written for one purpose gets read for another, and the
second reader inherits assumptions nobody wrote down. Naming what a field means
in the type, next to the field, is the cheapest place to break that chain.


## What a document promises, 2026-08-18

Three decisions from the same night, all about the distance between what this
service says and what it does.

**A published call has to work as printed.** `agent-access.json` is parsed by
something that then calls the URL, and it advertised the items list with a
cursor placeholder in it, which no first read can fill: an agent following the
card got `bad_cursor` from the endpoint the card had just recommended. The
guard is a test that walks every curl in `skill.md` and every endpoint on the
card, checks the route exists, and additionally refuses to let a read the card
publishes answer 400. Prose is exempt from that second rule, because a
document may legitimately show the second page of a walk; a machine-readable
card may not.

**The OAuth secret has no expiry of its own.** Reporting the project's deadline
as `client_secret_expires_at` was honest for a week and dishonest afterwards,
because claiming the project by email removes the deadline and a client that
honoured the field would abandon a credential whose board had become permanent.
Its only recovery, another registration, hands it a different board. So the
field is 0, which is what RFC 7591 means by no expiry, and `project_expires_at`
carries the date that actually exists. The endpoint enforces it rather than
trusting the TTL index, which deletes about a minute late.

**Compression is an allowlist, and it stays one.** Public text is three
quarters air and nothing was compressing it, so the landing page went over the
wire at 49 kB. A route opts in, and only routes whose bytes belong to nobody
do. Every read link, operator page and API answer carries a capability or a
CSRF token, and the length of a compressed response says a little about what is
inside it; keeping credentials out of the compressed set means that argument
never has to be had. Anyone reaching for a global compression plugin later is
trading that away for four documentation pages.

Beside them, one repair of the same family: a capability URL ends up pasted
somewhere public eventually, and those pages now answer `noindex`. The header
rather than a `robots.txt` rule, because a `Disallow` stops a crawler fetching
the page and therefore stops it ever reading the instruction.


## A counter that waits, 2026-08-18

CI found a project counter at minus one, on a commit that changed no runtime
code. The read of it took three attempts and each wrong answer is worth keeping,
because each one looked right.

Closing an item is two writes: the item's status, and then its slot going back
to the project. Everything that returns a slot has that shape. The overcount
repair recounts the work and lowers the counter to what it counted, guarded on
the counter still reading what it read. Between those two writes the counter
still says the old number while the work is already one lighter, so the repair
counts, matches its guard, writes the lower number, and the close's own
decrement lands on top of that. Minus one.

**First attempt: a timestamp.** Mark the moment before counting, then ask
whether any item changed since. It has three holes, and a review found all of
them: the mark was taken after the counter was read, so a close in that gap is
invisible; a deleted item leaves no timestamp to find; and a request stamps the
clock it read on the way in, so a write that lands during the count can carry a
time from before the mark. A guard that reads as a guarantee and is not one is
worse than no guard.

**Second attempt: clamp at zero.** Necessary, and kept: no path that returns a
slot can take a counter negative, so the worst case is a project with one extra
slot, which the next create raises again. But it bounds the damage rather than
stopping the race.

**What it does now: it waits.** The repair writes down what it saw and acts
only when a later sweep finds the same counter, at the same version, half a
minute on. The version is the part that makes this sound: every write that
moves a counter bumps it, so *two different halfway points cannot be mistaken
for one thing that never moved*. Numbers alone can: one item closing while
another opens brings the counter back to where it was, and two closes caught at
the same point read identically. A discrepancy that survives a version-stable
minute is the crash the repair exists for; one that does not was somebody
mid-write.

The two counters settle apart, because a board whose items move all day would
otherwise never sit still long enough to repair a question count stuck since a
crash last week, and that is precisely the case worth repairing.

What would close the race outright is making the item write and the slot write
one atomic write, which means transactions, which means a replica set under the
tests. That is a deliberate change, not a 5am one. The waiting version costs a
leak one extra minute of life and needs none of it.


## The question nobody was told about, 2026-08-18

The escalation notice is throttled to one per project per hour: a burst of
questions from an agent in a loop should not become sixty messages to somebody
asleep. The throttle was a rate limit in the comments and a delete in the code.
A question filed inside another question's hour sent nothing at all, and the
only record of it was a page nobody had open, which is the exact failure the
notice exists to prevent.

This board was carrying two of them when it was found: a question from the
afternoon that predated the mail path entirely, and one filed twenty four
minutes after another had claimed the hour. Neither had reached anybody in
fourteen hours.

Every question now carries whether anybody was ever told about it, and a pass
beside the hygiene sweep looks for the ones nobody was. One message per
project, naming the oldest such question, under the same hourly throttle. Every
question is mentioned by name exactly once, and one that is answered before its
turn comes simply drops off the list, so repairing the hole does not turn into a
nag.

Three details are load bearing and easy to undo by accident:

**Eligibility is decided in the query, before the batch is cut.** The first
version took twenty questions and then checked which projects had an owner and
an open hour. Twenty questions on abandoned boards would have taken every slot
from a board with somebody waiting, every five minutes, for ever.

**A question is read again on its turn.** Twenty provider calls take a while,
and a message asking somebody to answer something they answered ten seconds ago
is worse than no message.

**The pass has its own guard.** Sharing the hygiene sweep's meant that one
project whose sweep threw took the notifications down with it, silently, every
five minutes.


## One header that switched another one off, 2026-08-18

The capability pages carry `Referrer-Policy: no-referrer` because the read link
is a credential in the path, and a Referer header hands it to whatever a person
clicks through to next. The forms on those same pages are checked by comparing
`Origin` against our own, because a project narrowed to its owner opens on a
session cookie and a cross site post would then be worth forging.

Both are ordinary. Together they do not work. Fetch says that when a request's
referrer policy is `no-referrer`, the `Origin` header is serialized as `null`,
so every form on our own pages arrived looking like a stranger's, and the check
answered 403 to all of them: moving a card, setting an owner, answering a
question, asking for the board.

It survived a security audit and a suite with a cross site case in it, because
both asked what the check does with an origin, and neither asked what a browser
actually puts there under our own headers. It was found in the router log:
`POST /r/<token>/escalations/<id>` at 403, and the operator signing in thirty
seconds later to answer the same question the other way. The refusal page
prints the origin it got, so the response size named the value: four characters
where a real origin is twenty.

Two changes, and the order matters. The check now reads `Sec-Fetch-Site` first,
which is the one header this service cannot blank out with a policy of its own,
and only falls back to `Origin`. And the policy became `same-origin`, which
strips the header on everything that leaves the service, which is the entire
leak it was there for, while leaving our own pages an origin to send. A browser
too old for `Sec-Fetch-Site` is served by the second change, not the first.

One number was quietly ruined by this and is worth naming, because it was
collected to settle an argument. Drag and drop was refused on the grounds that
the operator barely moves cards by hand, and "cards moved by hand per board
view" exists to check that claim rather than believe it. Between the audit that
added the header and the repair, twenty one hours, every hand move was refused
before it reached the board, so a zero over that window says nothing about
anybody's preference. The count is printed with that window named beside it. A
measurement taken while the thing it measures is broken does not read as
missing; it reads as a confident zero, which is worse.

The general shape: a defence that reads a header is only as good as the other
headers around it. Two policies can each be correct and cancel out, and neither
one's test will say so.
