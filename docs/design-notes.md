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

## Counted at one door, 2026-08-18

The service has four doors, and by now most behaviour that reaches through more
than one of them goes through a single function on the other side. The counters
did not. Three of them were written at the route that first needed them, and
what the log said afterwards was not "some doors are missing" but something
worse: a confident number about the doors that happened to write it.

An answer was counted on the operator's page and nowhere else, so every human
decision appeared to arrive there. The mail does not send anybody there; it
sends them to the capability link, and that link recorded nothing. A project
created through the web form left no signup event at all, and that count is the
denominator of the activation and claim rates, so a form that converted well
would have pushed activation above one hundred percent rather than showing up as
a source. A question filed over MCP left no escalate event, and MCP is how most
agents arrive.

All three now happen inside the function every door already calls, and each
caller says which door it is. That is the same repair the inboxes got when they
had drifted apart, applied to the part of the system that was never checked for
drift because it does not change what anybody sees.

Two smaller things fell out of counting an answer properly, and both were real:
reopening a question ran through the same call and counted as answering it, and
two identical retries of an edit to an already answered question both passed a
guard that read only the status, so both won and both counted.

The general shape, and the reason this is worth a note rather than a commit
message: a measurement taken at one of several equivalent paths does not read as
incomplete. It reads as evidence about the paths, and the path that measures
zero is the one somebody eventually deletes.

## A decision taken from a stale read, 2026-08-18

The soak exists to check three things the unit tests cannot: that the open
counter matches the collection, that a slug never becomes two items, and that
two agents never hold one claim. Run against a build of this morning it reported
the first one broken, by one, and the interesting part is which direction. The
counter was *below* the collection, and the repair in the sweep only ever
lowers a counter. Nothing in this service raises one, so that gap does not close
on the next pass, or ever.

The interleaving is ordinary. Two agents write the same new slug, one of them
carrying a status. The second looks, sees nothing, and by the time its write
lands the first has created the item. The status then went out through `$set`,
onto a document nobody had read. Two things were missing at once, and both
matter: no guard, so no writer owned the transition, and no accounting, because
the counter moves either in the guarded branch or on creation, and this was
neither.

Both directions were reachable from there. A request meaning to create a done
item, landing on an open one, closed it and left the counter high, which the
sweep repairs. One meaning to create an open item, landing on a done one,
opened it and left the counter low, which nothing repairs. The board had been
accumulating that quietly for as long as two agents have shared a slug.

The fix is one word of intent: the status belongs in `$setOnInsert`, because
this branch was only ever reached by believing the item was new. Losing that
race means the other writer's status stands, which is the rule the guarded
branch already follows when it loses.

The shape worth remembering: a decision taken from a read has to be applied
under a guard that still holds, or not applied at all. `$set` on a document you
have not read is neither, and it is invisible, because the write succeeds and
the wrong number is the only trace.

## A heading that counts the page, 2026-08-18

Three pages carried the same fault today, and it took a review of the fix to
the first one to see that it was a shape rather than a bug.

A query is capped, sensibly: two hundred items, fifty questions, a hundred
across a fleet. The list under the heading then renders what came back, and the
heading counts the same array. The two are the same number right up until
somebody is busy, and after that the heading is about the page while the reader
believes it is about the world. The project page said "200 item(s)" above a
table that admitted, one line lower, that it was showing 200 of 205. The
operator page, whose entire promise is "everything waiting on you", put the size
of its own first page in the title. The same page counted each project's waiting
questions by filtering the slice, so a project's number shrank as other projects
got busier.

Worse than either, because it is silent in both directions: the questions on the
capability page were fetched as "the newest fifty of any kind" and split by
status afterwards, so fifty answers newer than an open question hid it
completely, and the page said the agents were unblocked. That is the bug the
audit found in the MCP inbox in July and fixed there. The door a person actually
opens kept it for another month.

Three rules came out of it, and they are cheap:

**Count with a count.** A heading is about the world, so it takes a
`countDocuments` or a maintained counter, never `list.length`.

**Say what is missing.** Every capped list says "showing N of M", the way the
board has always said "and N more". A page that quietly drops work is worse than
one that admits it cannot show everything.

**Ask for the kind you are going to show.** A query that fetches a mixture and
filters in memory has a cap on the mixture, not on the thing. The fix is one
query per kind, in the index built for it.

## What it costs when the data stops being small, 2026-08-18

Every measurement in this repository had been taken against a board with
seventy items on it. At that size a collection scan and an index are the same
number, so the shape of every query here was untested: the first evidence would
have been somebody's fleet slowing down after a year of writing.

`apps/server/tools/perf-audit.mts` fills a real mongod with fifty thousand
items, five thousand questions, two hundred boards and two hundred thousand
events, drives the paths a person and an agent take, and prints wall clock
beside what the planner had to read. The second number is the one that predicts
the future.

It found four scans and a sort of everything. What each one returned, and what
it read to do it, before and after:

| | examined | after | wall clock |
|---|---|---|---|
| the page the mail links to | 50,000 | 25 | 80 ms to 14 ms |
| a page of items, urgency order | 50,000 keys | 50 | 55 ms to 2 ms |
| the board | 50,000 | 1,000 | 73 ms to 9 ms |
| work assigned to a person, across a fleet | 23,491 | 59 | 121 ms to 5 ms |
| the stale list | 23,491 | 43 | 99 ms to 2 ms |
| answered questions, newest first | 4,878 | 50 | 15 ms to 1 ms |
| a hygiene sweep | | | 183 ms to 37 ms |

Only one of the three causes was a missing index.

**An index that stops one field short of the sort is not an index for it.** A
page of items sorts by priority, then date, then `_id`, because the keyset
cursor pages on the tiebreaker, and an index without `_id` cannot finish that
sort. Mongo used it and then sorted the project in memory anyway. All three
orders now have their own index, tiebreaker included, and the audit measures the
sorts the code issues rather than simpler ones that look like them.

**A rank computed in the pipeline cannot be indexed.** The project page ordered
statuses with a `$switch` so that live work came first, which reads well and
means "scan everything, then sort it". It asks for live work as live work now,
and fills the rest of the page from the recency index.

**A negation cannot be an equality bound.** The pass that decides what has gone
stale asked for `stale: {$ne: true}`, so the most expensive thing hygiene does
read every open item on the board, every five minutes, on every project.
`$in: [false, null]` against an index naming all four conditions took it from
153 ms to 1 ms. The `null` is there because an item written before the field
existed has no `stale` at all, and that one is still not stale.

Two things were measured and deliberately left alone. A search that matches
nothing reads the whole collection, 188 ms at fifty thousand items, because a
case insensitive substring in either field is not indexable; making it fast
means a text index, and that changes what the search means, which is a product
decision rather than a performance one. And `dropContentless` walks the open
items at 21 ms a sweep, which did not look worth an eleventh index on the
collection every write already pays for. The second of those was wrong at four
times the size, and the section below is what changed it.

## Four times the cap, and what an index costs, 2026-08-18

The audit above stopped at fifty thousand items in one project, which is above
what the largest plan sells. That plan caps a project at twenty thousand items
and the cap counts what is still open, so the closed work behind a board is
bounded by nothing: a fleet that finishes a hundred items a day carries a
hundred thousand of them into its second year, and every read that scales with
the collection rather than with the board scales with that. So the second pass
ran at two hundred thousand, and priced each new index on the writes as well as
on the reads. An audit that measures only the half it improved is an argument,
not a measurement.

| | before | after |
|---|---|---|
| `distinct` for the owner filter | 175 ms | 0 ms |
| `distinct` for the agent filter | 175 ms | 0 ms |
| `distinct` for the label filter | 175 ms | 175 ms |
| the pass that drops undescribed items | 680 ms cold, 70 ms warm | 6 ms |
| a search that matches nothing | 1016 ms | 1016 ms |

**An array field cannot be walked for its distinct values.** Three of the four
filter dropdowns are a `distinct` over the project, and an index turns each into
a walk of the distinct values: two hundred thousand documents read becomes a few
dozen keys, and the number goes to zero. The fourth is `labels`, which is an
array, so its index is multikey, and a multikey index cannot answer a `distinct`
without fetching the documents behind the keys. It measured 175 ms with the
index and 175 ms without it, while making every write to an item pay for a
second index: creating a hundred items went from 48 ms to 67 ms and moving a
hundred cards from 56 ms to 70 ms. The index was removed. An index that costs
writes and buys no read is worse than no index, and the only way to know which
one you have is to measure both halves.

**A filter should offer what its own board can show.** The same reads got a
correctness fix on the way past. The filters read every owner, label and handle
in the project, but a board only shows the statuses its columns ask for, so on a
layout with no column for finished work the dropdown offered the labels of a
year of closed items and picking one produced an empty board. They now read the
work the board itself scans, which is the narrower set on exactly the layouts
where the difference was visible.

**The narrower question is a different question.** That fix arrived with the
indexes above and quietly undid them on the boards it applied to: a `distinct`
over `{projectId, owner}` walks the distinct values, and the same `distinct`
with a status predicate between the project and the owner fetches every open
document instead, 80 ms and seventy seven thousand documents against 1 ms and
eight keys. Naming `status` in the key serves both questions from the same
index, so the board that shows everything is not paying for the board that does
not. A review caught this by reading the index against the query rather than
against the benchmark, which is the failure the benchmark itself could not see:
the audit measured the shape the code used to issue.

The writes were measured against the same collection: today's index set costs
about a tenth of a millisecond per write, and the reads it pays for went from
tens of milliseconds to one or two.

**The first read of a collection pays for reading it.** The pass that drops
items nobody ever described measured 680 ms as the first thing to touch the
items after a restart, and 70 ms once the pages were in cache: the same code,
the same query, an order of magnitude apart. Both numbers are real, and which
one a deployment sees depends on how long ago it restarted. A partial index over
the empty bodies takes it to 6 ms either way, and stays small by construction
because it holds only the documents the rule is about.

**Two things were measured and left alone again.** A search that matches nothing
still reads every item, now a full second of it. Indexing the two fields it
searches made it worse rather than better: the planner spent 1.1 s choosing
between the new indexes and the sort index, then picked the sort index and
fetched all two hundred thousand documents anyway. Making that fast is a change
to what the search means, not a change to how it is stored. And the insights
report costs half a second over two hundred thousand events, which is a page one
person opens, against the one collection every request writes to.

## The top of the funnel was counting robots, 2026-08-18

Page views drop crawlers where they are recorded, because "how often are we
indexed" is a different question from "how many people looked". The reads of the
protocol files, which are the top of the agent funnel, dropped nothing: every
fetch of `skill.md` or `llms.txt` counted, whatever fetched it. So the headline
the announcement decision rests on, two hundred and thirty three reads per
signup, was a mixture of agents that read the protocol and walked away and
robots that index a file every day and were never going to sign up.

Both numbers are worth having, so the crawler reads are kept and counted beside
the others rather than dropped. What is stored is one bit, read off the user
agent and not the user agent itself: the test that asserts these events hold
nothing about a person now names that bit explicitly, which is what stops the
next reason to look at a header from becoming a second copy of it.

The split starts the day it shipped. Everything written before has no bit at
all, and absent reads as "not known to be a crawler", so the old number keeps
its old meaning instead of quietly becoming a different one. Events are kept
ninety days, so the mixture ages out on its own.

## A clock on the one read that has no ceiling, 2026-08-18

The search above was left alone as a cost. A decision audit written the same day
found the part that is not a cost: `GET /r/:token/board?q=` has no rate limiter
in front of it, the limiter on those routes sits on the POST. So the one read
whose price is the whole collection is also the one read a stranger holding a
read link can send as often as they like, and the collection it reads is bounded
by nothing, because the cap on a project counts what is still open.

Searches now carry `maxTimeMS`, half a second, four times what the largest board
a plan sells can cost. Nothing else does: every other filter is answered from an
index and stops at the page, and a clock on those would be a clock on the boards
that are behaving.

A clock bounds one request and says nothing about how many arrive, so the two
pages behind a read link also took the ceiling the API door already gives the
same project. That needed two ceilings rather than one, and each of the two came
from a review of the fix before it. Charging the link's allowance before
checking the link let anybody holding a revoked one keep the owner locked out of
their own board; charging it only afterwards left the check itself uncounted,
and the check is a lookup plus, for anybody carrying a session, a session read
and a write. So: what one address may ask of these pages, charged first, which
is what makes a refusal cheap enough to hand out; and what one link may be read,
charged once it has opened something, which is the owner's and is spent by
nobody else.

**A stopped search is not an empty answer.** Both are a page with nothing on it,
and they mean opposite things: one says there is nothing to find, the other says
nobody looked long enough to know. The API refuses with 503 `search_too_slow`
and says how to narrow it, because an agent handed an empty list will act on it,
and the slug is the only thing standing between that and a duplicate. The board
page cannot refuse a person their board, so it drops the search, renders the
board they would have had without it, and says in one line which of the two
things happened.

Rejected in the same audit, with the reasons worth keeping: a tokenized `words`
array with prefix matching would make the search itself cheap, and would quietly
stop finding `svc-oauth-token` when somebody types `auth`, on a product whose own
slugs are namespaced and hyphenated. It also buys an eleventh index on the
collection every write pays for, larger than the `labels` index this repository
deleted two hours earlier for buying nothing. Worth revisiting on a trigger and
not before, and both triggers are measured rather than described. Any single
project passing fifty thousand items, printed by `tools/insights.mts` as
"largest board, items stored", with a line under it naming this note once it is
past. And any search that actually hits the clock: each one is recorded as a
refusal with the reason `search_too_slow`, so the question is "has this happened
here at all" rather than a percentile nothing computes. A trigger nobody
measures is a sentence in a document, and this repository has enough of those.

## Two guards, on the doors that had one, 2026-08-18

The suite already read every form these pages render and posted each one back
the way a browser does, which is the test that would have caught the night the
capability forms refused themselves. Adding the other half of that sweep, the
same posts arriving from another site, found the operator's own forms taking
them: the token in the form was the only guard there, while the capability
pages had the header check precisely because they have no token at all.

The token is still the guard that matters, and nobody can forge it without
reading a page they cannot read. The header check beside it costs nothing and
holds where the first one does not: a token that reached a log, a screenshot or
a paste is still a token, and a post carrying it from somebody else's page is
not that person acting. Both readings of `Sec-Fetch-Site` and `Origin` now live
in one file, which is also where the note about `Referrer-Policy: no-referrer`
blanking the Origin belongs, since both doors depend on it.

What makes this worth writing down is the shape of the test rather than the
guard. It sweeps what the pages actually render, both ways, so a form added next
month is covered on both sides without anybody remembering to add it here. Four
forms were added to the board this afternoon and none of them needed a line in
this test to be protected.

**And a capability has to say what it grants, on the day it grants it.** The
same afternoon put filing, notes and urgency behind the read link. The warning
on the page still said the link could answer questions and change the board, the
protocol file still said it could answer questions, and both were written when
that was the whole list. A link whose warning is a version behind is a link
somebody shares on the wrong reading of it.

## The board learned to take writing, 2026-08-18

For a day and a half this board was a place people read and agents wrote. The
person could move a card, assign it and tag it, and could not say why; could not
file work; could not answer a question from the card it was about; could not fix
a typo in a title. Every one of those was reported from a browser within an hour
of somebody actually using it, which is the fastest review this product has had.

**A note adds to the record, an edit replaces part of it.** They are different
enough to be different controls: the note field is open on the card, the edit is
folded behind a summary, and the difference is worth one click. The edit carries
the values it was rendered with, writes only the fields that actually changed,
and the expectation travels with the write as part of its filter rather than as
a check before it, because between reading a card and writing it there is room
for exactly the change the check exists to protect. A field somebody else moved
underneath is a 409 and nothing is written. An unrelated correction never costs
the other side its work.

**A slug is an idempotency key an agent needs and jargon a person should never
meet.** Filing from the board derives it from the title, which makes this the one
write here that must not upsert: two people filing "check the bridge fee" a week
apart mean two pieces of work. The lookup handles the ordinary case, a name
already in use, and `insertOnly` handles the race the lookup cannot see.

**Every queue here sorts by priority, so a person who cannot set it has filed
work that arrives last.** Four points on the item's own scale, in words, and
whatever number the item actually carries if an agent filed it off them, because
a control that shows the first option for a card at +7 quietly moves it to +5 the
moment somebody presses the button beside it.

**A filter with a button is a choice that has not happened yet.** There is no
JavaScript on these pages, so a `select` cannot apply itself: it needs a submit
beside it. Every value is a link instead. Choosing keeps whatever else is
narrowed, choosing what is already chosen clears it, so one control turns a
filter on and off and there is no small x to hunt for; the value in force leads
the row so it can never hide inside the fold. The search stays a form of one
field, because it is typed, and a browser submits that on Enter unasked.

**The reload is not a switch.** It was one for an afternoon, off by default, on
the reasoning that a page reloading under somebody's hands throws away the note
they were typing. That is still true and it is the wrong trade: this board is
written to by agents while somebody is looking at it, so a page that changes only
when a person presses something is wrong most of the time, and asking them to opt
into being told the truth is asking the wrong question.

**A capability has to say what it grants on the day it grants it.** Filing, notes
and urgency all went behind the read link, and the warning on the page still
described the shorter list it was written for. A link whose warning is a version
behind is a link somebody shares on the wrong reading of it.

## A sheet the server knows about, 2026-08-18

The reload is not a switch, and the note somebody is typing still gets thrown
away by it. Both halves of that were true at once: the board is written to by
agents while a person reads it, so it has to keep itself true; and the one thing
on the page that nothing else can recover is the sentence half typed into a card.

The card sheets were `:target` fragments, which is the cheapest disclosure a
browser gives you and the one thing a server never sees. No amount of care in the
route could hold a page still for a state nobody told it about.

**So the sheet became an address.** `?card=<slug>` opens one, `?new=1` opens the
filing form, both keep whatever the board was narrowed to, and closing is a link
back to the same board without them. The route reads which sheet is open, and
skips the refresh meta while one is. It is two parameters rather than two values
of one, because `new` is a slug a card can really have.

**It costs a round trip to open a card and saves one on every card that is not
open.** The board used to ship a preview, four forms and an answer form for every
card it drew: on a project with a hundred done items, a hundred sheets to open
one. Now it draws the one that was asked for. The demonstration on the front page
still runs on fragments, because it has no server behind it and nothing to lose.

**A sheet the page did not draw does not hold the refresh either.** A `?card=`
naming something the current narrowing filtered out is an ordinary board, and
letting it stop the clock would be a link that quietly makes the page stale.

**A sheet is resolved against the collection, not against the drawn cards.** A
column draws fifteen cards and keeps fifty, and a link somebody sent last week
outlives both: work filed above it is exactly how that card reaches position
sixteen, and then fifty one. Twice the fix was to widen the list it was looked up
in, and twice that only moved the number at which the permalink silently stops
opening anything. It is a lookup by slug now, and the history and the agent
descriptions the sheet shows are fetched for it whether or not it made the
slice.

## The option every new page forgot, 2026-08-18

The navigation asks one question: is somebody signed in. It was answered by a
`signedIn` option on the layout, so it was right on the pages that remembered to
pass it. It was reported once from a browser, fixed on the five pages that
existed, and came back on the pages written after: a read link told its signed in
reader to sign in on the same screen that addressed them by their email address,
and the 404 and every rate limit notice did the same.

**An option with a default is a question that will eventually be answered
wrong.** Rendering goes through one helper that takes the request now, so the
answer comes off the same place every time and there is nothing left to forget.
The test that lists the pages is a check on the helper rather than the fix for
the pages, which is the difference between the two attempts.

## The half of the repository nobody was checking, 2026-08-18

`pnpm typecheck` compiled `src` and nothing else, and the tests run through tsx,
which strips types without looking at them. So the tests and the tools were
unchecked: a stub mailer with a `send` method the `Mailer` interface has never
had, six calls passing three of `createProject`'s four arguments, a `$nin` typed
as somebody else's field. All of it ran, most of it even passed, and the mailer
took twenty minutes to diagnose by hand from a page that said "That code did not
work".

Twenty four errors when the check was widened, all of them in tests and tools,
none in `src`. That is the argument for widening it: the code that is only ever
run by a person watching is the code where a wrong shape survives longest.

## A query where a name belongs, 2026-08-18

Exposing the guarded write to agents put an object from an MCP tool call
straight into the filter of the write, one field after `projectId`. Codex caught
it within the hour: an `expect` of `{"projectId": {"$ne": null}, "slug":
"victim"}` would have reached another project's card. The fix was to rebuild the
guard in the service from its two known fields, because that is where every
door's arguments meet the query.

Then the obvious question: what else. Firing crafted arguments at a local copy
of the service answered it in five minutes. `inbox` with `agent: {"$ne": null}`
read every agent's inbox. `list_items` with `status: {"$ne": "nope"}` listed
everything. `next_item` with an object handle matched no agent and was handed
unscoped work. `claim_item` would have stored an object as the holder of a
lease, which nothing could then release by name. One object inside `observe`'s
`present` array reached `normalizeSlug` and came back as a 500.

**None of it crossed a project boundary, and that is the only reason this was a
bug rather than an incident.** The token scopes every filter to one project, so
the worst of it was reading and narrowing inside a board the caller already
holds. The lesson is not "MongoDB operators are dangerous", it is that a door
with no schema needs the reading to be the validation: the HTTP side has AJV and
refuses these by construction, and MCP arguments are whatever a model produced.

Two layers now. The tool arguments are read through something that refuses a
non-string instead of substituting one, and the service checks the handful of
values that land in a filter, so a third door tomorrow starts from the same
floor rather than from whatever its author remembered.

## Ten loops, one item, nine losers, 2026-08-18

`/next` does not claim, on purpose: reading what is next and taking it are
different decisions, and an agent that only wants to look should not have to
release afterwards. Firing ten concurrent asks at a local copy showed what that
costs a fleet: all ten were offered the same item, one won the claim that
followed and nine spent a round trip losing.

`claim=true` does both. The first shape of it offered and then claimed, with a
retry on losing, and three of ten still came back empty after losing three times
in a row. The gap between choosing and taking was the whole problem, so there is
no gap now: the selection filter and the sort go into the same
`findOneAndUpdate` that writes the lease, and MongoDB hands ten callers ten
different items. The claim write itself is one function used by both callers,
because two copies of it would drift, and the copy that stopped signing the item
or clearing its stale flag is the kind of difference nobody notices until a
board reads wrong.

The plain call is unchanged and still does not claim, which is what makes it
safe to poll.

**And it is a POST.** The first shape put `claim=true` on the GET, which codex
called out twice over: a GET that writes is one a proxy, a prefetch or a client
retry can take a second item with, and the rate limiter classifies by method, so
claiming through a GET was charged against the read budget, five times the
writes an agent is allowed. `POST /next` on the HTTP door; on MCP, where there
is no method to read, the tool is counted as a write when it is asked to claim.


## The filter bar, third shape, 2026-08-18

A select with a Show button was a choice that had not happened yet. Links applied
themselves and cost a row per name, which on a board with thirty labels is most
of the screen before the first card. The operator asked for the third shape: a
field per thing to narrow by, with the names this board already knows behind it,
so the values are one keystroke away and a name nobody has used yet can still be
typed.

**One form, and a submit button nobody sees.** A form with several fields and no
submit button does not submit on Enter: the rule is one field, or a button. The
button is off screen rather than absent, because there is still nothing to press
after choosing. Worth knowing when testing: with the suggestion list open, the
first Enter accepts the suggestion and the second submits, which is the
browser's behaviour and not something a page can change without script.

**And the address stays the one to share.** A form sends every field it has, so
narrowing by one wrote `?owner=&agent=errors-loop&label=&q=` into the bar. The
empties are dropped once, in the route, before the page is drawn.

## What the competition had that we did not, 2026-08-18

An audit of quentintou/agent-board, asked for by the operator. It is a
single-developer OpenClaw appliance: six commits in one day six months ago, JSON
files on disk, MCP over stdio only, no signup, no claims, no leases, no
discovery documents. We are not competing with it. Three of its ideas are worth
having anyway, and one of them is worth having tonight:

**A card can say what to file when it is finished.** Their `nextTask` spawns a
successor on completion, and it is the same idea as ours only because we already
address everything by slug: theirs duplicates the pipeline every time a template
is re-run, ours writes the same card twice, which is one card. One write now
says what to do and what to do next, and no orchestrator has to exist for a
four-agent pipeline to run. The chain fires on the crossing into a terminal
status, not on every write to a closed card, and it fires through a board move
as well because a move applies its status through the same write.

**Their refusals name the objects that caused them,** in a form an agent can
act on: "Blocked by unresolved dependencies: "Crawl & Technical Audit"
(task_ab12, status: doing)". Worth copying wherever ours still say only what
went wrong.

**One mutation reports its own side effects.** Their move answers with what it
retried and what it chained, so the agent does not read the board back to learn
what its own write set in motion. Ours now answers with `chained` for the same
reason.

Filed rather than built: blocking dependencies between items, which collides
with what `blocked` currently means here and deserves the operator's opinion;
and an attempt counter that reopens failed work and escalates when the attempts
run out, which is hygiene deciding to reopen somebody's card and is therefore
not mine to switch on unasked.

## The two proposals that came out of that audit, decided 2026-08-19

Both were filed as questions for the operator and both came back through a
decision audit, which is worth recording because the cheaper half of each
proposal turned out to be the whole value.

**Blocking dependencies: ship the data, never the status.** The tempting
implementation sets `blocked` when a prerequisite is unfinished and clears it
when the prerequisite closes. It is also wrong here, because `blocked` is
published as the queue for work waiting on a person, in skill.md and in the
operator's own headline. An engine writing it for a dependency two agents can
settle between themselves puts work no human can act on into a human's list,
and every edge case then resolves badly: a dropped blocker unblocks its
dependent because the prerequisite was *abandoned*, a deleted one blocks on a
slug nobody can find, hygiene re-blocks a card somebody holds a live lease on,
and a cycle parks two cards in a queue with nothing anybody can do about them.

So `blockedBy` is stored and never written by the server. It does two things an
agent meets rather than reads about: `/next` does not offer a card whose
blockers are unfinished, and a claim on one is refused with `blocked_by` naming
each unfinished card, its status and its title. A named card nobody has filed
counts as unfinished, because silently treating a typo as a finished
prerequisite is the failure only a person can find.

The answer is computed on the two paths that need it rather than kept as a
counter. That was the other half of the decision: a denormalized count needs a
fan-out write on every terminal crossing, a reverse index and a repair pass, and
this repository already has a forty-line note about how hard its two existing
counters were. Finishing a blocker now takes effect with nothing else running.

The cost of reversal decided it. This version unwinds to one unread field, one
paragraph of protocol and a refusal that stops firing. The version that writes
the status leaves cards in a state only a person can repair, with no provenance
to tell an engine-blocked card from a human-blocked one.

**Attempt counting: cut, and not to a rule that defaults to off.** "Failed" is
not observable from here. An expired claim is evidence a process stopped, which
this codebase already says twice: `markStale` exempts held work because a
heartbeat means somebody is on it, and the operator page treats an expired lease
as the operator's problem. Charging an attempt for a crashed loop bills the card
for the fleet's uptime. The other proxy is worse: `blocked` means waiting on a
person, so counting it as a failure and reopening pulls work out of a human's
queue and hands it back to the agent that just said it needs a human. Reopening
is also not a mark, and "hygiene marks, agents unmark" is the invariant the
whole engine rests on: it moves a status, clears `closedAt` and charges the item
counter, which `upsertItem` refuses at the cap, so the rule would have had a
failure mode with nobody to report it to.

What was real in it is the crash loop nobody hears about, and that is a push
rather than a rule on a card. It went into the timer pass that already existed.

## A read may tidy, but it may not close, 2026-08-19

Publishing MCP tool annotations turned a documentation question into a design
one. Two tools said they were read-only, and several clients run a read-only
tool without asking anybody; both of them triggered the whole hygiene sweep, so
listing items could expire claims, drop contentless cards and close items whose
source had gone quiet, unattended.

Hygiene is now split by what a caller is allowed to cause. A read expires leases
that have already lapsed, and nothing else. Writes and the five-minute timer do
the rest. Expiry stays on the read path because a read is the only place its
absence shows: a lapsed lease is free work the moment it lapses, but the row
does not change until something clears it, so a poller asking for unclaimed work
with `since` would never be told. Nothing else hygiene does has that property.

It takes its own throttle stamp rather than sharing `lastSweptAt`. Sharing it
meant a read could take the slot for a tenth of the work and leave the write a
second later skipping rules it was the only trigger for.

The annotations then say what is true rather than what is convenient.
`list_items` and `board` are not read-only, because clearing a lease is a write,
and the comment beside them says so. What they are is non-destructive, which is
the half a client actually weighs.

## The notice that exists because nothing happened, 2026-08-19

Everything else in this server waits to be read, which is right for a record and
useless for a fleet that died at three in the morning: an agent in a crash loop
never files the question that would have told anybody, because filing one is
work and it is not getting that far.

The condition is two things, not one. Silence alone is a board somebody parked;
silence plus hygiene's own judgement that the work is rotting is what a stopped
fleet leaves behind. The threshold for "rotting" is the project's own stale
setting rather than a number invented in the notifier.

One message per quiet spell, not one per period: the stamp only re-arms when the
board is written to again, so a month of silence is one message and a board that
wakes up and stops again is a second. A notice that repeats on a timer is a
notice people filter, and this one is about the absence of events, which does
not become more true by being said twice.

Two things learned from the review of it, both about messages that never
arrive. Ordering the candidates by when each was last *told* starves everything
behind twenty busy boards that have never been told anything; ordering by when
each was last *looked at* turns the queue over. And a delivery of `discarded`,
which is what a deployment with no mail provider answers, has to give the stamp
back: keeping it marks the board as told for ever, including after somebody
configures the provider.
