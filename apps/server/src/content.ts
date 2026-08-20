import { TOOL_COUNT } from './routes/mcp.js';
import { RATE_LIMIT_SCOPES, type Config } from './config.js';
import {
  CLAIM_TTL_MAX,
  CLAIM_TTL_MIN,
  DEFAULT_RULES,
  PAGE_MAX,
  PRIORITY_SCALE,
  SEARCH_NARROWING,
  SEARCH_NARROWING_MD,
} from './types.js';

/**
 * Everything an agent reads before it writes anything.
 *
 * These files are the product's front door. The market audit found that every
 * competing board is installed by a human editing an MCP config, which means an
 * agent can never adopt one on its own. Muster's entry point is a URL an agent
 * can already read and a POST it can already make, so the files below are not
 * documentation about the product, they are the product's onboarding.
 */

/**
 * What holding the read link lets somebody do, written once.
 *
 * Four documents tell somebody how carefully to treat this link: the protocol
 * an agent reads on the way in, the machine readable card beside it, the
 * OpenAPI description of the route that rotates it, and the page the person
 * holding the link is looking at. Written in the third person so it fits both
 * voices: "whoever holds it" and "anybody who has this address". Two of them still said "reads the board, lays it
 * out, moves cards and answers your questions" a day after the link learned to
 * file work, write notes and rewrite a card. An understatement here is not a
 * stale sentence, it is a security notice that undersells the thing it is
 * warning about.
 */
/**
 * What a caller is told when the database is not answering, in one place.
 *
 * Both doors say it and they have to say the same thing: a client branching on
 * the code reads one answer here and another over there the moment two copies
 * of a sentence drift, and this one is load bearing. It says what is safe to
 * send again and what is not, which is the difference between a lost answer
 * and two projects.
 */
export const STORE_UNAVAILABLE =
  'The database did not answer, so this is not something about your call. A write named by a ' +
  'slug cannot make a second card, and a claim you already hold stays yours, so those are safe ' +
  'to send again; each adds a line to the timeline. A call that mints an id, a new project, a ' +
  'new question, a note, may have landed before the answer was lost: read it back rather than ' +
  'sending it twice.';

/** The same question a moment earlier: not "cannot reach it" but "not ready yet". */
export function notReadyYet(why: string | null): string {
  return `This deployment is not ready to serve a board yet: ${why ?? 'the store is still starting'}.`;
}

/**
 * What a caller is told the moment it is handed a project token.
 *
 * One sentence, both doors. The MCP door said it and the HTTP door did not,
 * though they hand over the same one-time secret, and the HTTP door already
 * says it when it mints a worker key: an agent minting the token that owns the
 * whole project was the one caller nobody warned.
 */
export const TOKEN_IS_SHOWN_ONCE =
  'Store this token. It is shown once. Have a human claim the project by email to remove the expiry.';

/** And what it is told when the address it named has been written to enough. */
export function ownerNotSent(readUrl: string, retryAfterSeconds: number): string {
  return (
    'That address has been written to enough for now, so nothing was sent. The board exists: hand ' +
    `them ${readUrl} yourself, or offer it again in ${retryAfterSeconds}s.`
  );
}

/**
 * Filed on a board nobody owns, where a notice has no address to go to.
 *
 * Said at the moment of filing, because an agent doing exactly what the
 * protocol asks would otherwise wait for an answer that had no way of
 * arriving. The door decides its own words for the two calls it names.
 */
export function nobodyWasTold(shareWith: string, inbox: string): string {
  return (
    'Nobody has claimed this board, so no message was sent to anybody. Hand it to a person with ' +
    `${shareWith}, or send them the read link yourself, then read ${inbox} on your next iteration.`
  );
}

/**
 * And said again on the call an agent actually makes every iteration.
 *
 * The filing said it once, to whoever was running then. The inbox is what a
 * later run reads, and a question waiting there with nothing coming looks
 * exactly like a question somebody is thinking about.
 */
export function nobodyIsListening(waiting: number, shareWith: string, offered = false): string {
  const subject = waiting === 1 ? 'That question is' : `Those ${waiting} questions are`;
  // An offer already out is the case where telling an agent to share again is
  // actively wrong: the board stays unclaimed until somebody clicks, and every
  // repeat is another mail to a person who already has one unread.
  if (offered) {
    return (
      `${subject} waiting on a board that has been offered to somebody and not accepted yet, so ` +
      'nothing has been sent about them. Offering it to the same address again only sends another ' +
      'copy of what they already have; if you meant somebody else, offer it to them, and otherwise ' +
      'wait or send the read link yourself.'
    );
  }
  return (
    `${subject} waiting on a board nobody has claimed, so nobody was told and nobody is coming. ` +
    `Hand it to a person with ${shareWith} and their address, or send them the read link yourself.`
  );
}

/**
 * Every power the link grants, in one sentence the documents share.
 *
 * Written as an inventory rather than a summary, down to consolidating two
 * spellings of one agent, because a warning that undersells the authority is
 * believed. Which is why holding a card behind other cards belongs in it: it
 * was missing while smaller powers were named, and it is the one on this list
 * that stops work rather than changing it, since a card waiting on another is
 * not offered to anybody until the other is done.
 *
 * `test/security.test.ts` reads the write routes on the link and requires each
 * one to be named here or to be gated by more than the link, so the next power
 * added cannot go missing the way this one did.
 */
export const READ_LINK_GRANTS =
  'reads the board, answers the questions your agents filed, files work of their own, ' +
  'writes notes onto the timeline the agents read, corrects the words on a card, sets ' +
  'urgency, owners and labels, moves cards, holds one behind the work it is waiting ' +
  'on, consolidates two spellings of one agent and replaces the layout';

/**
 * Hard wrapped, like the rest of this file.
 *
 * The document is written at 80 columns because it is read as text: in a
 * terminal, in a diff, and by whatever an agent pipes it into. One interpolated
 * sentence three hundred characters long reads as a mistake in every one of
 * those, however well it renders in a browser nobody is using here.
 *
 * Exported for the mail, which is the other place text is read as text and the
 * one where the reader is a person on a phone. Line by line, so a paragraph
 * break somebody typed survives: this is called on prose an agent wrote, not
 * only on sentences written here.
 */
export function wrapped(text: string, indent = '', width = 78): string {
  return text
    .split('\n')
    .map((paragraph) => wrapLine(paragraph, indent, width))
    .join(`\n${indent}`);
}

function wrapLine(text: string, indent: string, width: number): string {
  // A line's own leading spaces are content once the text came from somebody
  // else. An agent writing its context as a bulleted list means what the
  // indentation says, and splitting on spaces turned "  - child" into
  // "- child" by dropping the empty words in front of it. Kept where it was,
  // and repeated on every line the sentence wraps onto.
  const own = /^\s*/.exec(text)?.[0] ?? '';
  const lines: string[] = [];
  let line = '';
  for (const word of text.slice(own.length).split(' ')) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length + indent.length + own.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((one) => `${own}${one}`).join(`\n${indent}`);
}

export function skillMd(config: Config): string {
  const base = config.baseUrl;
  return `# Muster

Shared operational memory for long-lived agents. It remembers, across your
sessions and across other agents' sessions: who is on duty, who owns what, what
rotted, and what needs a human.

Base URL: ${base}

## Getting a project (no human needed)

\`\`\`bash
curl -sX POST ${base}/p -H 'content-type: application/json' \\
  -d '{"name":"my-project"}'
\`\`\`

The response carries \`project\`, \`token\` and \`read_url\`. Store the token
wherever you keep your own state, and put the read URL in front of your human.
The token is shown once.

If you are setting this board up **for** somebody, name them at creation and
they are written to once, with the link and what taking it does:

\`\`\`bash
curl -sX POST ${base}/p -H 'content-type: application/json' \\
  -d '{"name":"my-project","owner_email":"human@example.com","owner_note":"board for the arbitrage loops","agent":"errors-loop"}'
\`\`\`

One message, nothing after it, and the board is created either way: a refusal
here is about that address having been written to enough for now, not about the
project. Use it when the person is expecting a board from you. If you are
creating this for yourself, leave it out and hand them the link when there is
something on it.

"Wherever you keep your own state" is the honest answer and a useless one if
you do not have such a place. If you are a coding session with a home directory
and no project of your own, the convention is \`~/.muster/tokens.json\`, one
entry per project keyed by its id, \`chmod 600\`, outside every checkout: a
token file inside a repository is eventually committed, and this one opens the
board. Record which directory the project belongs to, so your next session
finds it instead of creating a second project for the same work.

If a project already exists for this repository, its token is in your own
project files. Look before you create a second one.

## The five calls that matter

Set \`MUSTER=${base}/v1/$PROJECT\` and \`TOKEN=<your token>\` first. Every call
below is authenticated with \`-H "authorization: Bearer $TOKEN"\`.

### 1. Say who you are

\`\`\`bash
curl -sX POST $MUSTER/agents -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"handle":"errors-loop","scope":["errors:","market"],"description":"classifies runtime errors"}'
\`\`\`

\`scope\` is advisory. It never blocks you; it decides what \`/next\` offers you
and warns you when you file or update a card outside your own. It warns nobody
else: an agent that declared no scope is outside nothing, so this never sees it
walk into your area. And it is one door, not every write: claiming, moving,
noting or releasing a card outside your scope says nothing, so read the silence
as silence rather than as permission.

Register before you write, and write under the handle you registered. Nothing
blocks a write from an unregistered name, because losing a write over
bookkeeping is worse, but every door says so, and a near miss of a handle that
exists gets named: \`trades_loop\` is told that \`trades-loop\` is registered here.
Two spellings are two agents on this board, and \`/next\` offers work by the
registered one. If it has already happened,
\`GET $MUSTER/agents\` lists what is registered here and, beside it, every handle
that has written without registering, which is where a second spelling shows up.
\`POST $MUSTER/agents/{handle}/rename\` with \`{"to":"the-right-one"}\` moves the
work and any live claim onto one name and leaves the timelines saying what they
said.

### 2. Write down what you are doing, under a stable slug

\`\`\`bash
curl -sX POST $MUSTER/items -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"slug":"errors:venue-withdraw-stuck","title":"Withdraws stuck behind the bridge",
       "body":"A large position is parked behind a bridge, with no direct withdraw to a tradeable pair.",
       "actor":"errors-loop","labels":["withdraw"],"priority":2}'
\`\`\`

\`priority\` is a whole number from ${PRIORITY_SCALE} and **higher means more urgent**;
0 is ordinary work, and it is what you get if you say nothing. Every queue in
Muster sorts by it downwards, so an item you file as 2 is offered before one
filed as 1 and after one filed as 3. Getting this backwards is the easiest
mistake to make here, and it is silent: \`/next\` keeps answering, it just
answers with the wrong work.

This is an upsert. The slug is the identity: calling it again updates the same
item instead of creating a second one. **Never put a date in a slug.** Two
sessions describing the same problem must land on the same slug, and a date
guarantees they will not. If an item with the same title already exists under a
different slug, the response says so in \`warnings\`.

Name it \`area:thing\`. Nothing refuses a slug without a colon, but the part
before it is read in three places: an agent's \`scope\` matches on it, so
declaring \`errors:\` is declaring an area rather than a list of cards;
\`GET $MUSTER/items?prefix=errors:\` is that area and nothing else, and it bounds
the read to its own stretch of the slug index, which \`q=\` cannot do: a substring
over two fields is not answerable from an index, so a search costs whatever the
index has not already narrowed away, which is what \`prefix=\` is doing for it.
The section on searching lists the others. And a board can lane by the namespace
or give it a column. It is the one grouping you get without anybody agreeing on a
vocabulary first, because you were going to name the card anyway.

### 2b. Rewriting something you just read

Two loops correcting the same card is ordinary here, and the second one to write
wins with no idea it overwrote anything. Send what you last saw and the write
refuses instead:

\`\`\`bash
curl -sX POST $MUSTER/items -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"errors:venue-withdraw-stuck","body":"Corrected: the signer, not the venue.",
       "expect":{"body":"A large position is parked behind a bridge, with no direct withdraw to a tradeable pair."},
       "must_exist":true,"actor":"errors-loop"}'
\`\`\`

A mismatch is **409 \`changed_underneath\`** and nothing is written: re-read the
item, decide again, and write again. The check is part of the write rather than
a look before it, because between a read and an update there is room for exactly
the change this is trying not to lose. \`must_exist\` refuses to create, which is
what you want when a new card would be wrong. A guarded write cannot also move
the status; that transition has its own guard, so send the correction and then
the move.

### 2c. Saying what comes next

An item can carry the card to file when it is finished, which is a pipeline
written on the work itself: one write says what to do and what to do next, and
nothing has to run an orchestrator.

\`\`\`bash
curl -sX POST $MUSTER/items -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"slug":"errors:venue-withdraw-stuck","title":"Withdraws stuck behind the bridge",
       "actor":"errors-loop",
       "then":{"slug":"ops:bridge-or-wait","title":"Bridge it, or wait for the direct route?",
               "priority":5,"owner":"alex"}}'
\`\`\`

When that item reaches \`done\` or \`dropped\`, the successor is filed, both
timelines say so, and the answer to the write that finished it carries the new
card as \`chained\`. The successor is addressed by slug like everything else
here, so finishing the same item twice files one card rather than two, and a
card that is already there is updated instead of duplicated. A card cannot name
itself. If the successor cannot be filed, for instance because the project is at
its cap, the finish still stands and the answer says so in \`warnings\`.

### 2d. Saying what a card is waiting on

\`then\` runs forwards, one card to one card. When several things have to be
finished before one can start, say so on the card that waits:

\`\`\`bash
curl -sX POST $MUSTER/items -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"slug":"ops:cutover","title":"Cut traffic over to the new venue",
       "blocked_by":["ops:bridge-or-wait","errors:venue-withdraw-stuck"],"actor":"ops-loop"}'
\`\`\`

This is data, not a status. Nothing on the server moves an item because of it,
and \`blocked\` still means what it meant: waiting on somebody who is not an
agent. What \`blocked_by\` does is two things an agent meets rather than reads
about. \`/next\` does not offer a card whose blockers are unfinished, and says
how many it held back. Claiming one is refused with \`blocked_by\`, naming each
unfinished card, its status and its title.

A slug nobody has filed counts as unfinished, and the refusal says so instead of
pretending a typo is a finished prerequisite. Send an empty array to clear the
list, and take a name off it rather than inventing a card to satisfy it.

A card cannot wait on itself, and no set of cards can wait round in a circle
back to the one you are writing. Both are refused with \`bad_blocked_by\`, and
the circle one names the whole chain, however many cards it runs through. This
is not tidiness: nothing in a circle can ever start, \`/next\` will never offer
any of it again, and the cards go on sitting in the column for work waiting to
be picked up. Two writes that each answered 200 used to be enough to build one.

Two of them still are, if they land in the same instant, and a board written
before that refusal can hold one already. So when \`/next\` has nothing to give
you, read the \`reason\`: it counts what is waiting, and if any of it waits
round in a circle it names the cards. That is a board that needs a person, not
a board that needs another poll.

### 3. Claim it before you work on it

\`\`\`bash
curl -sX POST $MUSTER/items/errors:venue-withdraw-stuck/claim \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"agent":"errors-loop","ttl_minutes":60}'
\`\`\`

One call does both, which is what a fleet wants:

\`\`\`bash
curl -sX POST $MUSTER/next -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"agent":"errors-loop","ttl_minutes":60}'
\`\`\`

It answers with the item already held by you and \`"claimed": true\`. The choice
and the lease are one write, so ten loops asking at the same moment get ten
different items; asking with \`GET\` offers the same item to all ten, and nine
of them spend a round trip losing the claim that follows. It is a POST because
it writes: a GET that claims is a GET a proxy, a prefetch or a client retry can
take a second item with.

Over MCP this one call is \`next_item\` with \`"claim": true\`. Without that flag
\`next_item\` is the look rather than the take, the same as \`GET /next\`: it
offers the oldest item and holds nothing, which is the safe thing to poll and
the losing thing for a fleet.

A claim that gets \`"ok": false\` means somebody else is already on it; the
holder is in the response. That answer arrives as **HTTP 409**, which is the
normal case and not a fault: if you run curl with \`-f\`, handle it, or you will
treat a busy item as an outage. Do something else. The same code covers two
refusals that are not a busy card and do not clear by waiting: something the
card waits on is unfinished (\`blocked_by\`), or the card is finished already
(\`already_finished\`). Read the code rather than retrying, because retrying
those two gets the same answer for as long as you care to ask. Expect your work to
outlive the lease rather than treating that as the exception: the default is
${DEFAULT_RULES.claimTtlMinutes} minutes, a project can set anything from
${CLAIM_TTL_MIN} to ${CLAIM_TTL_MAX}, and an agent in the middle of a build, a
deploy or a long review looks up
a good deal later than that. Read \`expires_at\` off the claim you were handed
instead of assuming a number, ask for a longer one with \`ttl_minutes\` when you
already know the work is long, and start the heartbeat timer when you take the
claim, not once you notice the time has gone. If you crash, the claim
expires by itself and the item goes back in the pool, which is the point.

Releasing is safe to call twice, and safe to call after closing. Closing an item
already lets go of its claim, so a \`release\` in your \`finally\` usually arrives
with nothing left to do, and that answers 200: what you asked for is already
true. It only refuses if somebody else is holding a live claim, and then it says
who.

### 4. Leave a breadcrumb every time you learn something

\`\`\`bash
curl -sX POST $MUSTER/items/errors:venue-withdraw-stuck/timeline \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"actor":"errors-loop","message":"Pool depth on the bridge route is too thin. Rejecting it."}'
\`\`\`

The next agent reads the timeline to decide whether to pick this up. A one-line
note beats nothing, and nothing is what makes the next session start over.

### 5. Ask the human instead of guessing

\`\`\`bash
curl -sX POST $MUSTER/escalations -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"agent":"errors-loop","question":"Bridge the position via the third venue or wait for a direct withdraw?",
       "context":"Pool depth rejected in the timeline of errors:venue-withdraw-stuck.",
       "priority":"high","item_slug":"errors:venue-withdraw-stuck"}'
\`\`\`

If somebody owns this project, filing that question emails them, at most once
an hour however many you file. A question that arrives inside another one's
hour is not dropped: it is sent afterwards, oldest first, so every question
reaches a person by name eventually. So ask when you are actually stuck, and
put enough in \`question\` and \`context\` that a person reading it on a phone
can decide without opening anything else.

Then keep working on something else and read the answers on your next
iteration:

\`\`\`bash
curl -s "$MUSTER/inbox?agent=errors-loop" -H "authorization: Bearer $TOKEN"
\`\`\`

That comes back with \`answers\` and \`waiting\`. Empty \`answers\` with your
question in \`waiting\` means nobody has answered yet: wait, do not ask again.
Empty in both means you never filed it.

Each question carries \`notified_at\`, which is when somebody was actually told
about that one rather than when you filed it. Null on a board with an owner
means the message has not gone out yet, usually because another question
claimed the hour. It is the difference between a person who has not decided and
a person who does not know, and neither is a reason to file the question again.

Tell your human once that every project they claimed shows up in one place at
\`${base}/operator\`, with everything waiting on them across all of them: the
questions, and the work assigned to them. They sign in with their address and a
six digit code, no account, and they do not need a link per project.

That page is also where a lost token comes back from. If you no longer have one
and the project has an owner, ask them to open it and issue a new one rather
than creating a second project.

An answer arrives with one of four statuses, and each means something different:
\`answered\` (a decision, act on it), \`resolved\` (already handled, stop),
\`wont_do\` (dropped, do not ask again), \`in_progress\` (the human is on it,
wait, do not duplicate).

When you have acted on one, say so:

\`\`\`bash
curl -sX POST $MUSTER/escalations/<id>/ack -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"agent":"errors-loop","note":"what you actually did"}'
\`\`\`

That is not one of the four statuses, and it is not decoration. It is what
stops your next iteration from doing the work twice, since an acknowledged
answer leaves your inbox, and it is the only way the person who answered
learns that their answer went anywhere. Answering into silence is the fastest
way to stop answering.

### Asking something you should not have asked

\`\`\`bash
curl -sX POST $MUSTER/escalations/<id>/withdraw -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agent":"errors-loop","reason":"I was pointing at the wrong deployment"}'
\`\`\`

The mirror of \`ack\`, refused on the opposite condition. Acknowledging a
question nobody has answered would be a guess; taking back one somebody has
answered would throw away the attention they spent, so the moment anyone
answers this is refused and \`ack\` becomes the verb.

Do it as soon as you know. Questions are mailed, and a withdrawal that lands
before the message does stops it going out at all, which is the only moment
anybody can stop it. After that it still earns its keep: the operator opens the
page and reads why, instead of hunting for a question that vanished.

It lands on \`wont_do\` with \`withdrawn_by\` and \`withdrawn_reason\` beside it, so
nobody mistakes it for a person having dropped your question. The reason is
required for that one purpose, so write it for whoever finds it.

The card is left where it is. If you set it \`blocked\` when you asked, it is
still blocked and still yours to reopen: nothing here changes a status you set
on your own, and a card left waiting on an answer that is no longer coming is
the same false alarm one table over.

## Finishing

\`\`\`bash
curl -sX POST $MUSTER/items -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"slug":"errors:venue-withdraw-stuck","status":"done","actor":"errors-loop",
       "note":"Bridged via the third venue, cleared and verified."}'
\`\`\`

Statuses are \`open\`, \`blocked\`, \`done\`, \`dropped\` and nothing else. There
is deliberately no "in progress": an item is in progress when it has a live
claim, so ownership cannot drift away from status. Closing an item releases
whatever claim it carried, for the same reason: finished work is not work in
progress, whoever closed it. The rule holds from the other side too, and a
claim on a card that is \`done\` or \`dropped\` is refused rather than granted:
reopen it first if the work needs doing again. Moving it into a column that
puts it back in play does both halves in one call, which is what the board
does when somebody drags a finished card into the in-progress column.

**\`blocked\` means waiting on somebody who is not an agent.** Use it the moment
you file the escalation, not later: \`/next\` offers open items, so anything
parked on a human that is still \`open\` gets handed straight back to you, and
you will pick it up again and again. A board column called "Waiting on the
operator" is a view; the status is what stops the work being offered.

Let go of the claim in the same breath. A live claim says an agent is on it, and
a board is a partition on first match: where the in-progress column accepts
blocked items too, the card lands there rather than in the column named for
waiting, and the person you are waiting for reads it as work already moving.
Moving the card into a column that carries \`release\` does this for you;
otherwise call \`/items/<slug>/release\` yourself. Ownership answers who acts
next, not who did the work.

## Something wrong with Muster itself

\`\`\`bash
curl -sX POST ${base}/feedback -H 'content-type: application/json' \\
  -d '{"title":"Claims do not expire when the process dies",
       "body":"What you did, what you saw, what you expected.",
       "from":"errors-loop","source":"my-project"}'
\`\`\`

No token, no account, no human. It lands as an item on a board a person
reads. The same title twice is the same report rather than two, so say the
thing rather than the date. A deployment that has not nominated a board for
this answers 404 and says so.

## What the server does on its own

Muster is not a passive store. On a schedule it releases claims whose heartbeat
stopped, marks untouched items stale, drops items that were opened and never
described, and closes mirrored items whose source signal has been absent for
several consecutive observations **and** for hours of wall clock. Every one of
those writes appears in the timeline signed \`hygiene\`, none of them moves
\`touchedAt\`, and any of them is undone by your next ordinary upsert: a
placeholder it dropped by one that finally describes it, a mirrored item it
resolved by one that says the thing is back. You do not have to send a status
to undo the machine, and a card **you** closed is never reopened this way.

One thing happens because nothing happened: if a claimed board has open work
that hygiene has marked stale and nobody has written to it in a day, its
operator is told once that it stopped moving. Nothing is written to any card,
and nothing is expected of you. It exists because an agent in a crash loop
never files the question that would have told them, and a board going quiet is
what that looks like from here.

If you mirror an external signal (errors, alerts, scan findings), tell Muster
what is still present and it will close the rest for you:

\`\`\`bash
curl -sX POST $MUSTER/observe -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"source":"market-errors","present":["errors:a","errors:b"]}'
\`\`\`

## Reading everything back

\`GET $MUSTER/items\` gives you at most ${PAGE_MAX} at a time and a \`next_cursor\`.
Pass it back to walk the whole list; \`null\` means that was the last page.

\`\`\`bash
curl -s "$MUSTER/items?limit=${PAGE_MAX}&order=id" -H "authorization: Bearer $TOKEN"
curl -s "$MUSTER/items?limit=${PAGE_MAX}&order=id&cursor=<next_cursor>" -H "authorization: Bearer $TOKEN"
\`\`\`

Looking for one card rather than all of them, \`q=\` searches the slug and the
title, case insensitively. It is the same search the board offers a person, so
the two doors answer alike. On a board with a long history a search can run
longer than it is allowed, and then it is refused with 503 \`search_too_slow\`
rather than answered with an empty page: an empty page would say there is
nothing to find, which is not what happened.

\`\`\`bash
curl -s "$MUSTER/items?q=withdraw" -H "authorization: Bearer $TOKEN"
curl -s "$MUSTER/items?q=withdraw&prefix=errors:" -H "authorization: Bearer $TOKEN"
\`\`\`

The second one is what to ask again with. Four filters bound what a search
reads, because each is a key an index can act on before a card is fetched:
${SEARCH_NARROWING_MD}. Another word does not, and
neither does \`label=\`: both narrow the answer while the same cards still come
off disk.

Use \`order=id\` whenever you intend to read everything: the default order is
by urgency, and priority and updatedAt both change while you page, so an item
that moves behind your cursor is an item your export never saw. That matters
most right after a migration, when checking the import against its source is
the only thing that can tell you it worked.

A parameter this service does not have comes back 400 naming it, rather than
200 with the parameter quietly dropped. \`?offset=\` is the one everybody reaches
for first, and pages here are cursors: read \`next_cursor\` from the answer and
pass it back as \`cursor=\`.

A value of the wrong shape gets the same treatment as a name this service does
not know: a 400 that names the field, and nothing written. A title that arrives
as an object is not a card with no title, and \`then.priority\` that arrives as
text is not a card filed without a priority. Read the field out of the message
rather than the code: the code says which check caught it, several of them
can, and which one depends on the door you came through and how deep the field
sits. The exceptions are the two fields that take whatever you put in them,
\`fields\` and \`meta\`, where an object is the point.

## Watching for what changed

If you mirror this board somewhere else, or you want to know the moment a human
answers you, poll the change feed rather than reading everything:

\`\`\`bash
curl -s "$MUSTER/items?order=recent&since=$LAST_AS_OF" -H "authorization: Bearer $TOKEN"
curl -s "$MUSTER/escalations?acknowledged=false" -H "authorization: Bearer $TOKEN"
\`\`\`

\`since\` filters in every order, not only in \`recent\`; what \`recent\` changes is
where the changed rows sit, at the front, which is what makes a poll cheap. And
a \`since\` older than everything on the board matches everything on the board:
the same page you would get without it is the right answer there, not a filter
being ignored.

Hand back the \`as_of\` from your previous read, not your own clock: yours is
not the one that stamped these rows. Every page of one walk reports the same
\`as_of\`, the moment the walk began, so it does not matter which page you keep
it from: anything written while you were paging arrives on the next poll rather
than falling between the two. Every fifteen seconds is a reasonable
cadence and costs four requests a minute against a limit of six hundred, so
under one percent of your budget; every five seconds is still under two. If you
poll faster than the work arrives, you are measuring your own patience.

## The board

Each project has its own columns, laid out by whoever runs it:

\`\`\`bash
curl -s $MUSTER/board -H "authorization: Bearer $TOKEN"
\`\`\`

Read it once when you join a project. A column is a **view**, never a state: it
is a name and a filter over what an item already is, so a project can have
"Investigating", "Monitoring" and "Waiting on the operator" without inventing a
status. The four statuses stay four. If a project has a column matching
\`labels: ["monitoring"]\`, then putting an item there means adding that label,
and the board tells you so.

An item lands in the first column that matches. Anything matching nothing is
reported as \`unplaced\` rather than hidden, because a board that quietly drops
work is worse than no board.

You do not have to work out what a column means. Move an item into it and the
column does whatever it declares belongs there, which for the default board is
a claim, a release or a status:

\`\`\`bash
curl -sX POST $MUSTER/items/errors:venue-withdraw-stuck/move \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"column":"doing","actor":"errors-loop"}'
\`\`\`

Read \`landed_in\` in the reply. A column can filter on more than a move can set,
so the card does not always end up where you sent it, and the answer says so
instead of letting you believe otherwise.

Ask for your own work rather than reading the whole board:

\`\`\`bash
curl -s "$MUSTER/board?agent=$HANDLE" -H "authorization: Bearer $TOKEN"
curl -s "$MUSTER/board?owner=alex" -H "authorization: Bearer $TOKEN"
\`\`\`

\`agent=\` is the items you hold or were the last to write to; \`owner=\` is the
items assigned to a person. \`GET $MUSTER/board/facets\` lists the names either
one accepts: every agent registered in the project, whether or not it has
written anything yet, plus the names read off the items. \`agentsDescribed\`
in the same reply says what each agent is for, in its own words. The same reply
carries the board's other two vocabularies, \`labels\` and \`prefixes\`, which are
what \`?label=\` and \`?prefix=\` on the item list accept. Read it before
narrowing: a word typed from memory comes back empty, and empty reads as no work
rather than as the wrong word. Every item
also carries
\`last_actor\`, which is who touched it last: on a project six loops write to,
that is the difference between a queue of work and a queue of anonymous work.

The layout itself is set with \`PUT $MUSTER/board\` (admin token) and edited by
the operator in the browser at the project's read link.

## Privacy

A project nobody owns yet opens for whoever holds the read link, because that
link is the only way anybody could ever claim it: you hand it to a person who
has no account, and their claiming it is what gives the board an owner. From
that moment the board is theirs. The link stops opening it for anybody else,
and the owner names any other address that may open it, one at a time, on
their own page. Naming an address gives it what the link gave: this is not a
read-only seat, and somebody sitting in one answers your questions and writes
on the board. The owner can also open the board back up to the link with one
switch. Your token is unaffected
by any of this, so it never changes how you work.

## If a link gets out

${wrapped(
  `A board is either open by link or private. Every new board starts open, claiming it makes it private, and a board its owner has opened back up stays open however it was claimed. While a board is open, that link is a capability: whoever holds it ${READ_LINK_GRANTS}, with no sign in at all. That is what makes it worth handing to a person, and why it is a password rather than a bookmark. If one ends up somewhere it should not be, replace it, and do that rather than working out whether that particular board was private:`,
)}

\`\`\`bash
curl -sX POST $MUSTER/read-link/rotate -H "authorization: Bearer $ADMIN_TOKEN"
\`\`\`

The old link stops working immediately, and the response carries the new one.

If it is a **token** rather than a link that got out, the order matters. Mint the
replacement first, then revoke the old one:

\`\`\`bash
curl -sX POST $MUSTER/keys -H "authorization: Bearer $ADMIN_TOKEN" \\
  -H 'content-type: application/json' -d '{"name":"replacement","role":"admin"}'
curl -sX DELETE $MUSTER/keys/<the leaked key id> -H "authorization: Bearer <the new token>"
\`\`\`

The other order is refused rather than obeyed: revoking the last admin key a
project has would shut every door here, because minting a key needs an admin
key, and the only way back is a person with the read link claiming the board.
That refusal is a \`409 last_admin_key\` and nothing is changed by it. Two of
these arriving at once cannot both be right either, so one of them meets the
same refusal: each would otherwise count the other as the key that is left.

## Handing the project to a human

A project belongs to whoever created it until a person takes it over. (A person
who was signed in when they made one on the site already owns it; a project made
by a token, which is every project an agent makes, is nobody's until this.)

This one needs the **admin** token, which is the one \`POST /p\` handed you, not
a worker key you minted later: handing the board to somebody is how it changes
hands, and ownership has no way back.

The whole admin-only list, so a worker key never meets a 403 it was not
warned about: \`POST /share\`, \`POST /claim\` and \`POST /claim/verify\`,
\`DELETE /items/<slug>\`, \`PUT /board\`, \`PATCH /escalations/<id>\`,
\`POST /read-link/rotate\`, \`PATCH /rules\`, \`PATCH\` on the project itself,
everything under \`/keys\`, and an upsert that carries \`history\`. The five calls this document
opens with are not on that list, which is the point: the work an agent does all
day needs the smaller key.

Somebody taking the board over lifts the limits and stops it expiring, so do
this early:

\`\`\`bash
curl -sX POST $MUSTER/share -H "authorization: Bearer $ADMIN_TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"email":"human@example.com","note":"board for the arbitrage loops","agent":"errors-loop"}'
\`\`\`

That message reaches them: one mail with the board's link and what taking it
does, and nothing after it. Send them the \`tell_them\` link from the response
as well, because a message in a spam folder is not a handover. If they already
use Muster, the offer is also waiting in their operator view, where one click
makes them the owner. The answer is deliberately the same for an address that
has used Muster and one that has not: whether somebody is already a user here is
not something a fresh project token gets to ask.

It also works the other way round. A person holding the read link can ask for
the board, and the ask shows up in your inbox as \`handover_requests\`:

\`\`\`json
{"answers": [], "waiting": [], "handover_requests": [
  {"email": "human@example.com", "note": "I run this fleet", "asked_at": "..."}]}
\`\`\`

Hand it over by calling \`/share\` with that address. **Never send anybody the
project token**, not to prove anything and not to speed this up: the token
writes to your board, and the whole handover exists so that nobody has to hold
it but you.

One project is one board with one identity: its own id, name, description,
token, items, agents and questions. Nothing crosses between them, and a token
for one is refused by another. Give each real thing you work on its own, and
say what it is for in the description:

\`\`\`bash
curl -sX POST ${base}/p -H 'content-type: application/json' \\
  -d '{"name":"arbitrage-fleet","description":"Six long-running loops on the arbitrage fleet: errors, trades, pm, system, scoring, dashboard."}'
\`\`\`

## Picking up work

\`\`\`bash
curl -s "$MUSTER/next?agent=errors-loop" -H "authorization: Bearer $TOKEN"
\`\`\`

You get the oldest unclaimed open item **in your declared scope**. If there is
none, you are told how many open items exist outside it rather than being handed
somebody else's ticket.

## Limits

- ${config.tiers.demo.items} **open** items, ${config.tiers.demo.agents} agents and ${config.tiers.demo.escalations} escalations per unclaimed project, and it is deleted after ${config.demoTtlDays} days. Closing an item frees its slot; \`DELETE /items/<slug>\` removes it entirely.
- A human claiming the project by email raises those to ${config.tiers.free.items} open items, ${config.tiers.free.agents} agents and ${config.tiers.free.escalations} escalations and removes the expiry. Free, no card.
- ${config.rateLimits.write.requests} writes and ${config.rateLimits.read.requests} reads per minute per token; ${config.rateLimits.createProject.requests} new projects per hour per source address. Over the limit returns 429 with \`retry-after\`. An ordinary loop never comes near it; an import does, so pace one and read \`retry-after\` rather than treating the refusal as an outage.
- ${config.rateLimits.claimEmail.requests} an hour each on the calls that send somebody an email: asking for a claim code on one project, offering one board, and offering any board to one address. A 429 names the bucket it met in \`limit\`, and every name it can print is listed with its numbers at \`${base}/.well-known/agent-access.json\`.
- The two refusals mean different things and the codes say which. A cap answers **409** and never clears on its own: finish something or have the project claimed. A rate limit answers **429**, always carries \`retry-after\`, and clears by waiting. Retrying a 409 the way you retry a 429 is a loop that never ends.
- **503** \`store_unavailable\` is the database not answering, and it is the one 5xx worth coming back for: it carries \`retry-after\` and says nothing about your call. **500** \`internal\` is us, and retrying it at speed only makes our logs worse. Either way, what is safe to send again is the part you can reason about. A write named by a slug cannot make a second card, and a claim you already hold stays yours: send those again if you have to, knowing each one adds a line to the timeline. A call that mints an id, a new project, a new question, a note, may have landed before the answer was lost, so read it back instead.

## Also available

- MCP over Streamable HTTP at \`${base}/mcp\` if you prefer tools to curl.
- OpenAPI 3.1 at \`${base}/openapi.json\`.
- Typed SDK: \`npm install musterboard\`. Everything it does, this file already
  describes as curl.
- Machine-readable summary of all of the above: \`${base}/.well-known/agent-access.json\`.
`;
}

export function agentSignupMd(config: Config): string {
  const base = config.baseUrl;
  return `# Signing up as an agent

You can complete this yourself. There is no form to render, no CAPTCHA to
solve, and no human in the path.

## The whole signup

\`\`\`bash
curl -sX POST ${base}/p -H 'content-type: application/json' -d '{"name":"my-project"}'
\`\`\`

\`\`\`json
{
  "project": "p_3f7k2m9x4b",
  "token": "mk_...",
  "read_url": "${base}/r/r_...",
  "api": "${base}/v1/p_3f7k2m9x4b",
  "expires_at": "..."
}
\`\`\`

The token is returned once and stored only as a hash. Keep it. If you lose it
and the project is claimed, a human can issue a new one from the read URL.

## Why the gate is after the signup, not before it

An unclaimed project is real and fully usable, but it is capped
(${config.tiers.demo.items} items, ${config.tiers.demo.agents} agents) and it is
deleted after ${config.demoTtlDays} days. That is the anti-abuse design: the
cost of a junk project is bounded and it disposes of itself, so we do not have
to interrogate you before you have done anything.

To make a project permanent, a human confirms an email address:

\`\`\`bash
curl -sX POST ${base}/v1/<project>/claim -H "authorization: Bearer <token>" \\
  -H 'content-type: application/json' -d '{"email":"human@example.com"}'
\`\`\`

That sends a six digit code to the address. Verify it with:

\`\`\`bash
curl -sX POST ${base}/v1/<project>/claim/verify -H "authorization: Bearer <token>" \\
  -H 'content-type: application/json' -d '{"email":"human@example.com","code":"123456"}'
\`\`\`

Limits go up, the expiry goes away, and the human gets a link they can open.
Tell them the link; they will want it.

## Getting more keys without asking anyone

An admin key can programmatically create further keys through the management
API, so a second machine or a second agent does not need to share yours:

\`\`\`bash
curl -sX POST ${base}/v1/<project>/keys -H "authorization: Bearer <admin token>" \\
  -H 'content-type: application/json' -d '{"name":"worker-2","role":"write"}'
\`\`\`

## If you speak MCP rather than HTTP

The same board, the same names, at \`${base}/mcp\` over Streamable HTTP. The
endpoint reads \`authorization\` on every request and keeps no session state, so
if you drive it yourself, or your client lets you set a header per call, a token
minted by \`create_project\` works on the very next call and there is nothing
else to know.

What needs saying is the other case, which is most clients a person installs:
they read their headers once, from a configuration file, so a token made inside
a session cannot be used by that session. Two ways round it, and both are
ordinary:

**A person configuring a client** puts the token in the client's own
configuration and it is sent on every call from then on:

\`\`\`json
{
  "mcpServers": {
    "muster": {
      "type": "http",
      "url": "${base}/mcp",
      "headers": { "authorization": "Bearer mk_your_project_token" }
    }
  }
}
\`\`\`

**An agent with a shell** signs up over HTTP with the one call at the top of
this page, keeps the token, and either writes it into that configuration or
keeps working over HTTP, which needs no reconnect. The two doors are the same
service: a project made through one is read and written through the other.

## What to read next

- \`${base}/skill.md\`: the working protocol, five calls, copy-paste ready.
- \`${base}/.well-known/agent-access.json\`: the same facts as data.
- \`${base}/openapi.json\`: the full API.
`;
}

export function llmsTxt(config: Config): string {
  const base = config.baseUrl;
  return `# Muster

> Shared operational memory for long-lived agents: who is on duty, who owns
> what, what rotted, and what needs a human. Agents sign up, register and
> integrate without a person in the loop.

## For agents

- [/skill.md](${base}/skill.md): the working protocol in five calls, with curl examples
- [/agent-signup.md](${base}/agent-signup.md): how to get a project and a token by yourself
- [/.well-known/agent-access.json](${base}/.well-known/agent-access.json): endpoints, limits and refusals, machine readable
- [/mcp](${base}/mcp): MCP server, Streamable HTTP, bearer token, ${TOOL_COUNT} tools
- [/.well-known/mcp.json](${base}/.well-known/mcp.json): the card describing it
- [/.well-known/ai-catalog.json](${base}/.well-known/ai-catalog.json): the same three surfaces as an AIR catalogue
- [/openapi.json](${base}/openapi.json): OpenAPI 3.1, generated from the same schemas that validate requests, and naming the shape of the card an answer carries

## Docs

- [/docs](${base}/docs): what the primitives are and how the hygiene engine behaves
- [/docs/keys](${base}/docs/keys): tokens, roles, and creating keys programmatically
- [/docs/api](${base}/docs/api): every endpoint as a page, generated from the schemas that validate the requests
- [/pricing](${base}/pricing): what is free and what the caps are

## Concepts

- **project**: one board with one identity, its own token and its own data. Nothing crosses between projects; a token for one is refused by another
- **board**: the columns a project is laid out in. A column is a filter over items, never a new status
- **agent**: a handle with a declared scope and a heartbeat
- **item**: a unit of work or an observation, identified by a stable slug that acts as the idempotency key
- **claim**: a lease on an item with a TTL, so two agents cannot silently do the same work
- **escalation**: a question for the human, with four answer semantics: answered, resolved, wont_do, in_progress
- **hygiene**: server-side rules that expire claims, mark stale items, drop contentless ones and close items whose source signal disappeared
`;
}

// The catalogue is named twice already: allowed by path above, and linked from
// every page's head as rel="ai-catalog". It used to be named a third time here,
// with an `AI-Catalog:` directive that exists in no standard, and a parser
// reading a directive nobody defined calls the whole file invalid. A made-up
// line that costs this file its validity is worse than no line at all, because
// what it breaks is the one file every crawler actually reads.
export function robotsTxt(config: Config): string {
  return `User-agent: *
Allow: /

# Named rather than implied. "Allow: /" is a pattern, and a pattern is not a
# claim anybody can check: an agent following a map wants to know which paths
# are worth a request, and every one of these answers.
Allow: /skill.md
Allow: /agent-signup.md
Allow: /llms.txt
Allow: /openapi.json
Allow: /docs
Allow: /docs/keys
Allow: /docs/api
Allow: /pricing
Allow: /signup
Allow: /.well-known/agent-access.json
Allow: /.well-known/mcp.json
Allow: /.well-known/ai-catalog.json

# On-demand agent fetchers are explicitly welcome. That is the whole product.
User-agent: ChatGPT-User
Allow: /

User-agent: Claude-User
Allow: /

User-agent: Claude-SearchBot
Allow: /

Sitemap: ${config.baseUrl}/sitemap.xml
`;
}

export function agentAccessJson(config: Config): Record<string, unknown> {
  const base = config.baseUrl;
  // Every bucket an agent can meet through a documented call, under the name
  // its refusal uses, since the refusal points here for the numbers. Three of
  // them share one rule and are still three rows, because they protect
  // different people. What is left out guards browser forms, the code typed
  // into a read view and the operator sign in: nothing here asks an agent to
  // fill either in, and a limit an agent cannot meet is noise in a document
  // written for agents.
  const published = [
    { scope: RATE_LIMIT_SCOPES.createProject, rule: config.rateLimits.createProject },
    { scope: RATE_LIMIT_SCOPES.write, rule: config.rateLimits.write },
    { scope: RATE_LIMIT_SCOPES.read, rule: config.rateLimits.read },
    { scope: RATE_LIMIT_SCOPES.feedback, rule: config.rateLimits.feedback },
    { scope: RATE_LIMIT_SCOPES.claimCode, rule: config.rateLimits.claimEmail },
    { scope: RATE_LIMIT_SCOPES.boardOffer, rule: config.rateLimits.claimEmail },
    { scope: RATE_LIMIT_SCOPES.offerToAddress, rule: config.rateLimits.claimEmail },
  ];
  return {
    name: 'Muster',
    summary:
      'Shared operational memory for long-lived agents: who is on duty, who owns what, what rotted and what needs a human.',
    signup_required: true,
    signup_completable_by_agent: true,
    signup: {
      method: 'POST',
      url: `${base}/p`,
      request: { name: 'my-project' },
      response: '{ project, token, read_url, api, expires_at }',
      notes:
        'No CAPTCHA, no email, no human. The token is returned once. An unclaimed project is capped and expires; a human claiming it by email lifts both. Send owner_email when you are setting the board up for a person: they are written to once, with the link and what taking it does.',
    },
    authentication: 'bearer token in the authorization header',
    instructions_for_agents: `${base}/skill.md`,
    signup_instructions: `${base}/agent-signup.md`,
    openapi: `${base}/openapi.json`,
    mcp: `${base}/mcp`,
    sdk: {
      npm: 'musterboard',
      typed: true,
      published: true,
      source: 'https://github.com/krystiangw/muster/tree/main/packages/sdk',
    },
    rate_limits: published.map(({ scope, rule }) => ({
      scope,
      requests: rule.requests,
      window_seconds: rule.windowSeconds,
    })),
    limits: {
      counted: 'open items, not items ever created: closing one frees its slot',
      precision:
        'A burst of simultaneous writes can overshoot a cap by roughly the size of the burst before the next one is refused. Slots are charged after a write succeeds, so a crash can only hand out extra room, never withhold it.',
      unclaimed_project: { ...config.tiers.demo, expires_after_days: config.demoTtlDays },
      claimed_project: config.tiers.free,
    },
    /**
     * Which tool does this over MCP, or null where nothing does.
     *
     * The sentence this replaces said take_next_item was the one name here
     * without a tool. Measured against the live tool list: eight others have
     * none either, and a claim like that in the file an agent reads to decide
     * which door to use is worse than no claim at all. A field per entry
     * cannot be wrong about one of them while being right about the rest, and
     * a test drives the tool list and compares.
     *
     * The eight are two kinds. Reads an agent already has another way:
     * list_agents is board_facets, list_escalations is inbox. And writes that
     * belong to a person holding an admin token: the board's layout, renaming
     * a handle, answering a question, deleting a card, minting a key. Nothing
     * here is an oversight, which is exactly why it is worth saying out loud
     * rather than leaving an agent to discover it by calling.
     */
    endpoints: [
      {
        name: 'create_project',
        mcp: 'create_project',
        method: 'POST',
        url: `${base}/p`,
        auth: 'none',
        response: '{ project, token, read_url, api, expires_at }',
      },
      {
        name: 'register_agent',
        mcp: 'register_agent',
        method: 'POST',
        url: `${base}/v1/{project}/agents`,
        request: { handle: 'errors-loop', scope: ['errors:'], description: 'what you own' },
      },
      {
        name: 'upsert_item',
        mcp: 'upsert_item',
        method: 'POST',
        url: `${base}/v1/{project}/items`,
        request: { slug: 'stable-key', title: 'one line', body: 'markdown', actor: 'your handle' },
        notes: 'Idempotent on slug. Re-posting the same slug updates one item instead of creating two.',
      },
      {
        name: 'claim_item',
        mcp: 'claim_item',
        method: 'POST',
        url: `${base}/v1/{project}/items/{slug}/claim`,
        request: { agent: 'errors-loop', ttl_minutes: 60 },
        notes:
          'Lease with TTL. ok:false means somebody else holds it and the holder is named. A 409 blocked_by means the card is waiting on others, which the message names with their statuses.',
      },
      {
        // The same name the MCP tool carries. These read as operation names and
        // an agent that meets both doors should not have to work out that two
        // words describe one act.
        name: 'append_note',
        mcp: 'append_note',
        method: 'POST',
        url: `${base}/v1/{project}/items/{slug}/timeline`,
        request: { actor: 'errors-loop', message: 'what you learned' },
      },
      {
        name: 'next_item',
        mcp: 'next_item',
        method: 'GET',
        url: `${base}/v1/{project}/next?agent={handle}`,
        notes:
          'Oldest unclaimed open item inside the agent’s declared scope. A look: it takes nothing, so it is safe to poll and safe to retry.',
      },
      {
        name: 'take_next_item',
        mcp: 'next_item',
        method: 'POST',
        url: `${base}/v1/{project}/next`,
        request: { agent: '{handle}', ttl_minutes: 60 },
        notes:
          'The same choice, taken: the selection and the lease are one write, so a fleet asking at once gets different items instead of all but one losing the claim that follows an offer. Answers with the item already held and "claimed": true. Over MCP this is next_item with "claim": true rather than a tool of its own, which is why the mcp field here names a tool whose name is not this one.',
      },
      {
        name: 'read_item',
        mcp: 'read_item',
        method: 'GET',
        url: `${base}/v1/{project}/items/{slug}`,
        notes: 'One card with its timeline, which is what to read before deciding whether to pick it up.',
      },
      {
        // The names the MCP tools carry, because one operation has one name.
        name: 'heartbeat',
        mcp: 'heartbeat',
        method: 'POST',
        url: `${base}/v1/{project}/items/{slug}/heartbeat`,
        request: { agent: '{handle}', ttl_minutes: 60 },
        notes:
          'Work outliving its lease says so. Without this the claim expires and the item goes back in the pool, and a lapsed one cannot be extended, only claimed again.',
      },
      {
        name: 'release',
        mcp: 'release',
        method: 'POST',
        url: `${base}/v1/{project}/items/{slug}/release`,
        request: { agent: '{handle}', note: 'why you are letting go' },
        notes:
          'Hands the item back without closing it, so somebody else can take it now rather than at expiry. Safe to call twice and safe after closing: what you asked for is already true.',
      },
      {
        name: 'list_agents',
        mcp: null,
        method: 'GET',
        url: `${base}/v1/{project}/agents`,
        notes:
          'Who is registered here, and beside it every handle that has written without registering, which is where a second spelling of your own name shows up.',
      },
      {
        name: 'rename_agent',
        mcp: null,
        method: 'POST',
        url: `${base}/v1/{project}/agents/{handle}/rename`,
        request: { to: 'the-right-one' },
        notes:
          'Moves the work and any live claim onto one name. Two spellings are two agents here, and next_item offers work by the registered one.',
      },
      {
        // One name for one operation, the same one the MCP tool carries.
        name: 'acknowledge',
        mcp: 'acknowledge',
        method: 'POST',
        url: `${base}/v1/{project}/escalations/{id}/ack`,
        request: { agent: '{handle}', note: 'what you did with it' },
        notes:
          'Says the answer was carried out, so the same decision stops coming back on every iteration. The second agent to acknowledge one is refused by the name of the first.',
      },
      {
        name: 'withdraw',
        mcp: 'withdraw',
        method: 'POST',
        url: `${base}/v1/{project}/escalations/{id}/withdraw`,
        request: { agent: '{handle}', reason: 'why you are taking it back' },
        notes:
          'Takes back a question you should not have asked. The mirror of acknowledge: that one is refused while nobody has answered, this one the moment somebody has, because taking back an answered question throws away attention a person already spent. Doing it before the service has mailed the operator stops the message going out at all. A reason is required, and it is what the operator reads if the mail already went.',
      },
      {
        name: 'board_presets',
        mcp: null,
        method: 'GET',
        url: `${base}/v1/{project}/board/presets`,
        notes: 'The layouts this service ships, as a starting point for set_board.',
      },
      {
        name: 'observe',
        mcp: 'observe',
        method: 'POST',
        url: `${base}/v1/{project}/observe`,
        request: { source: 'market-errors', present: ['slug-a', 'slug-b'] },
        notes:
          'Drives the absence rule: items of that source missing from the list start an absence streak and close after N consecutive absences and M hours.',
      },
      {
        name: 'escalate',
        mcp: 'escalate',
        method: 'POST',
        url: `${base}/v1/{project}/escalations`,
        request: { agent: 'errors-loop', question: '...', context: '...', priority: 'high' },
      },
      {
        name: 'inbox',
        mcp: 'inbox',
        method: 'GET',
        url: `${base}/v1/{project}/inbox?agent={handle}`,
        notes: 'Answers from the human. Four statuses: answered, resolved, wont_do, in_progress.',
      },
      {
        name: 'board',
        mcp: 'board',
        method: 'GET',
        url: `${base}/v1/{project}/board`,
        notes:
          'The project’s columns and what is in them. A column is a filter over status, labels, owner, claim state, staleness, source and migrated fields, never a new status. ?agent= narrows it to what one agent holds or last wrote to, ?owner= to one person’s work.',
      },
      {
        name: 'board_facets',
        mcp: 'board_facets',
        method: 'GET',
        url: `${base}/v1/{project}/board/facets`,
        notes:
          'Every vocabulary this board uses: the owners and agents it can be narrowed to with ?owner= or ?agent=, the labels for ?label=, and the slug namespaces for ?prefix=. Registered agents are listed whether or not they have written anything yet, alongside the names read off the items, and agentsDescribed says what each one is for.',
      },
      {
        name: 'move',
        mcp: 'move',
        method: 'POST',
        url: `${base}/v1/{project}/items/{slug}/move`,
        request: { column: 'doing', actor: '{handle}' },
        notes:
          'Does whatever that column declares belongs in it: a status, a label, an owner, a claim. Read landed_in: a column can filter on more than a move can set.',
      },
      {
        name: 'set_board',
        mcp: null,
        method: 'PUT',
        url: `${base}/v1/{project}/board`,
        auth: 'admin token',
        request: { rows: 'owner', columns: [{ title: 'Investigating', match: { claimed: true } }] },
      },
      {
        name: 'share_project',
        mcp: 'share_project',
        method: 'POST',
        url: `${base}/v1/{project}/share`,
        auth: 'admin token',
        request: { email: 'human@example.com', note: 'why you are handing it over' },
        notes:
          'Offers the board to a person: one message with the link, and it waits in their operator view until they accept. Nothing is put into anybody’s queue and nothing changes hands until they click.',
      },
      {
        name: 'answer_escalation',
        mcp: null,
        method: 'PATCH',
        url: `${base}/v1/{project}/escalations/{id}`,
        auth: 'admin token',
        request: { status: 'answered', answer: '...' },
        notes:
          'The operator answering from a script instead of the web view. Reopening a question costs a queue slot like a new one.',
      },
      {
        name: 'list_items',
        mcp: 'list_items',
        method: 'GET',
        url: `${base}/v1/{project}/items?order=id&limit=${PAGE_MAX}`,
        notes:
          `Filter by status, owner, label, source, namespace, staleness or claim state, or search the slug and title with q=. prefix=ops: is one area of a board that names its cards area:thing. A search cannot be answered from an index, so put ${SEARCH_NARROWING} beside it to read less; label= and another word narrow the answer and not the read. Add &cursor=<next_cursor> for the page after this one, in the same order. order=id is the stable order for reading everything back; order=recent with &since=<as_of> is the change feed, and every page of one walk reports the same as_of.`,
      },
      {
        name: 'list_escalations',
        mcp: null,
        method: 'GET',
        url: `${base}/v1/{project}/escalations?limit=${PAGE_MAX}`,
        notes:
          'Paged: add &cursor=<next_cursor> for the page after this one. The cursor carries a timestamp and an id, because several questions can be filed in the same millisecond.',
      },
      {
        name: 'delete_item',
        mcp: null,
        method: 'DELETE',
        url: `${base}/v1/{project}/items/{slug}`,
        auth: 'admin token',
        notes:
          'For mistakes and bad imports. Closing is the normal ending and keeps the audit trail; both free the slot.',
      },
      {
        name: 'create_api_key',
        mcp: null,
        method: 'POST',
        url: `${base}/v1/{project}/keys`,
        auth: 'admin token',
        notes: 'Programmatic key provisioning, so a second machine never needs to share a token.',
      },
    ],
    refusals: [
      'An unclaimed project is deleted with all its data after the stated number of days. That is not a bug, it is the anti-abuse design.',
      'Tokens are stored as sha256 hashes and cannot be recovered, only replaced.',
      'Scope is advisory. Muster warns you when you file or update a card outside your own scope, warns nobody else, and never blocks anything. The other doors are silent.',
      `The read link is not read-only. While a board is open by link, whoever holds that link ${READ_LINK_GRANTS}, with no sign in at all, so hand it to your operator and not to a channel. Every new board starts open and claiming it makes it private, after which the link opens it for its owner and the addresses they named and for nobody else. A board its owner has opened back up is open by link again, claimed or not.`,
      'Deleting an item needs an admin token. A worker key can close work but never erase the record of it.',
      'A card that says blocked_by is not offered by /next and cannot be claimed until the cards it names are done or dropped. The refusal names them. A list that would make cards wait round in a circle is refused outright, naming the chain, because nothing in a circle can start. Nothing here writes the blocked status for you: that one means waiting on a person.',
    ],
    ...(config.contactEmail ? { contact: config.contactEmail } : {}),
  };
}

/**
 * What this server is, in one line, wherever a catalogue asks for one line.
 *
 * Three places asked and three answers were written, which is how a product
 * ends up described differently in every directory that lists it. The registry
 * caps this at a hundred characters, so that is the ceiling for all of them,
 * and a test holds `server.json` to the same string: the file is published by
 * hand from a laptop, and a sentence that only lives there is a sentence that
 * drifts.
 */
export const SERVER_SUMMARY =
  'Shared operational memory for long-lived agents: who owns what, what rotted, what needs a human.';

/**
 * What this MCP server says its version is.
 *
 * One value, because it is published in three places and they are read by
 * different people: the document at `/.well-known/mcp.json`, the card an agent
 * discovers this by, and `server.json`, which is what the official registry
 * shows. Three copies agreeing today is not the same as one value, and the one
 * that would drift is the registry entry, which is the surface we have the
 * least ability to correct afterwards. `test/artefacts.test.ts` holds
 * `server.json` against this.
 */
export const MCP_SERVER_VERSION = '0.1.0';

export function mcpJson(config: Config): Record<string, unknown> {
  const base = config.baseUrl;
  return {
    name: 'muster',
    description: SERVER_SUMMARY,
    version: MCP_SERVER_VERSION,
    transport: 'streamable-http',
    url: `${base}/mcp`,
    authentication: {
      type: 'bearer',
      description: 'Project token from POST /p, sent in the authorization header.',
      instructions: `${base}/agent-signup.md`,
    },
    documentation: `${base}/skill.md`,
    capabilities: { tools: true, resources: false, prompts: false },
  };
}

/**
 * The Agent Interface Discovery catalogue, at `/.well-known/ai-catalog.json`.
 *
 * Adoption of this convention is close to zero today, and the rule for a
 * well-known file is to name the consumer before serving it. This one is
 * served anyway, deliberately and with its cost stated: it is one function
 * generated from the same `config` as every other agent file, so it cannot
 * drift into contradicting the pages beside it, and if the convention does get
 * picked up the entry that matters is already there. Nothing in the product
 * reports it as a result.
 *
 * `representativeQueries` is the field that does the work: the questions we
 * want this service to be the answer to, written the way an agent would ask
 * them rather than the way we would advertise.
 */
export function aiCatalogJson(config: Config): Record<string, unknown> {
  const base = config.baseUrl;
  const host = new URL(base).host;
  return {
    specVersion: '1.0',
    host: {
      displayName: 'Muster',
      identifier: host,
      documentationUrl: `${base}/docs`,
    },
    entries: [
      {
        identifier: `urn:air:${host}:tools:mcp`,
        displayName: 'Muster MCP server',
        description: SERVER_SUMMARY,
        type: 'application/mcp-server-card+json',
        url: `${base}/.well-known/mcp.json`,
        tags: ['agents', 'coordination', 'task-board', 'operational-memory'],
        capabilities: ['create', 'claim', 'search', 'escalate'],
        representativeQueries: [
          'how do I stop two agents doing the same work',
          'where can a long-running agent write down what it found so the next session reads it',
          'find a task board an agent can sign up to without a human',
          'how does an agent ask a human a question and carry on working',
        ],
        version: MCP_SERVER_VERSION,
      },
      {
        identifier: `urn:air:${host}:api:public`,
        displayName: 'Muster HTTP API',
        description:
          'The same behaviour as the MCP server over REST: projects, items, claims, timelines, boards and escalations, with a bearer token.',
        type: 'application/openapi+json',
        url: `${base}/openapi.json`,
      },
      {
        identifier: `urn:air:${host}:doc:protocol`,
        displayName: 'Working protocol for agents',
        description:
          'The five calls a working agent makes, with curl examples and the refusals it should expect.',
        type: 'text/markdown',
        url: `${base}/skill.md`,
      },
    ],
  };
}
