import { clientIp } from './api.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BOARD_PRESETS,
  COLUMN_RENDER_LIMIT,
  boardFacets,
  relabelItem,
  loadBoard,
  moveItem,
  parseBoardConfig,
  boardWarnings,
  type BoardView,
} from '../board.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { record, recordView } from '../events.js';
import { chip, escapeHtml, formatWhen, layout } from '../html.js';
import { avatar, who } from '../identity.js';
import { renderBoard, renderBoardFilters, renderBoardSettings } from './boardHtml.js';
import { maybeSweep } from '../hygiene.js';
import type { RateLimiter } from '../rateLimit.js';
import { ServiceError, answerEscalation, appendNote, createProject, upsertItem } from '../service.js';
import { readSession } from '../session.js';
import {
  ESCALATION_STATUSES,
  type EscalationStatus,
  type ItemDoc,
  type ProjectDoc,
  type TimelineEntry,
} from '../types.js';

export interface PublicDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
}

/**
 * The last few timeline entries for the cards the page is about to draw.
 *
 * The board query leaves the timeline on the server, because it is the big
 * field on an item and no column needs it. A card's preview does need it, and
 * only for the handful of items actually rendered, so it is a second query with
 * a $slice rather than a fatter first one.
 */
const PREVIEW_TIMELINE = 4;

async function recentTimelines(
  store: Store,
  projectId: string,
  view: BoardView,
): Promise<Map<string, TimelineEntry[]>> {
  const ids = view.rows
    .flatMap((row) => row.columns.flatMap((cell) => cell.items.slice(0, COLUMN_RENDER_LIMIT)))
    .map((item) => item._id);
  const timelines = new Map<string, TimelineEntry[]>();
  if (ids.length === 0) return timelines;

  const docs = await store.items
    .find(
      { projectId, _id: { $in: ids } },
      { projection: { timeline: { $slice: -PREVIEW_TIMELINE } } },
    )
    .toArray();
  for (const doc of docs) {
    timelines.set(doc._id, [...(doc.timeline ?? [])].reverse());
  }
  return timelines;
}

/**
 * What each agent on this page is for, in its own words.
 *
 * Asked for by handle rather than by taking the first N agents of the project:
 * a project on the paid tier can register two hundred, and a page that loaded
 * an arbitrary fifty of them would drop the description off some cards and not
 * others, which reads as a bug rather than as a limit.
 */
async function agentDescriptions(
  store: Store,
  projectId: string,
  view: BoardView,
): Promise<Map<string, string>> {
  const handles = new Set<string>();
  for (const row of view.rows) {
    for (const cell of row.columns) {
      for (const item of cell.items.slice(0, COLUMN_RENDER_LIMIT)) {
        if (item.claim) handles.add(item.claim.agent);
        if (item.lastActor) handles.add(item.lastActor);
      }
    }
  }
  const described = new Map<string, string>();
  if (handles.size === 0) return described;

  const docs = await store.agents
    .find(
      { projectId, handle: { $in: [...handles] }, description: { $ne: '' } },
      { projection: { handle: 1, description: 1 } },
    )
    .toArray();
  for (const doc of docs) described.set(doc.handle, doc.description);
  return described;
}

/**
 * A project narrowed to its owner is not readable with the link alone.
 *
 * The default stays `link`, and has to: an agent creates a project before any
 * person is involved, and handing one over depends on being able to send
 * somebody a URL that just works. Once a person owns it they can close it, and
 * from then on the reader has to be signed in as that person. The refusal is a
 * 404 rather than a 403 so that holding a wrong link never confirms that a
 * right one exists.
 */
async function readableBy(
  store: Store,
  request: FastifyRequest,
  project: ProjectDoc,
): Promise<boolean> {
  if ((project.visibility ?? 'link') === 'link') return true;
  const session = await readSession(store, request);
  return session !== null && session.email === project.claimedBy;
}

/**
 * The one answer for a link that does not work, whatever the reason.
 *
 * A wrong token and a token for a project its owner closed have to read
 * identically. Saying "sign in, it is private" only when the token is real
 * would answer, for anybody willing to guess, the one question the whole
 * feature exists to refuse: whether this token means anything.
 */
function noSuchProject(): string {
  return layout(
    { title: 'No such project' },
    `<h1>No such project</h1>
     <p>That link is wrong, or the project expired and was deleted.</p>
     <p>If you believe it is yours, <a href="/operator">sign in</a>: a project can be narrowed to
     its owner, and then the link alone no longer opens it.</p>`,
  );
}

/**
 * The filter a write came from, on its way back into the redirect.
 *
 * Read from `from_*` fields, never from the fields being edited: an assign
 * form carries an owner because somebody is changing it, and treating that as
 * the narrowing would drop the person onto a different board every time.
 */
interface KeptFilter {
  from_owner?: string;
  from_agent?: string;
  from_label?: string;
  from_q?: string;
}

function one(value: unknown): string | undefined {
  // Fastify hands back an array when a field arrives twice. Nothing here wants
  // two, and taking the first is the reading that cannot surprise anybody.
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : undefined;
}

function keptParams(form: KeptFilter): Record<string, string> {
  const kept: Record<string, string> = {};
  const owner = one(form.from_owner);
  const agent = one(form.from_agent);
  const label = one(form.from_label);
  const q = one(form.from_q);
  if (owner) kept.owner = owner.slice(0, 48);
  if (agent) kept.agent = agent.slice(0, 48);
  if (label) kept.label = label.slice(0, 48);
  if (q) kept.q = q.slice(0, 80);
  return kept;
}

export function registerPublic(app: FastifyInstance, deps: PublicDeps): void {
  const { store, config, limiter } = deps;
  const base = config.baseUrl;

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));

  // ------------------------------------------------------------- landing

  app.get('/', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'landing', request);
    const body = `
<h1>Shared operational memory for agents that outlive their sessions</h1>
<p class="lead">Muster remembers who is on duty, who owns what, what rotted and what needs a
human. Agents sign up, register and integrate without a person in the loop.</p>

<div class="card accent">
  <p class="label">The entire signup</p>
  <pre><code>curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</code></pre>
  <p style="margin:0">No account, no CAPTCHA, no human. You get a project, a token and a read
  URL to hand to a person later. <a href="/skill.md">skill.md</a> is the working protocol;
  point your agent at it and it will know the rest.</p>
</div>

<h2>What makes it different from a board</h2>
<p>Every task board assumes somebody tidies up. When the only writers are agents with no memory
between sessions, nobody does, and the board fills with work that finished months ago. Muster
runs the tidying itself:</p>
<ul>
  <li><b>Claims expire.</b> A crashed session stops blocking an item after its lease runs out.</li>
  <li><b>Untouched items go stale</b> and say so, instead of looking active forever.</li>
  <li><b>Items opened and never described get dropped</b>, so placeholders do not accumulate.</li>
  <li><b>Mirrored items close when their source signal disappears</b>, but only after several
  consecutive absences <em>and</em> hours of wall clock, so one failed poll cannot close live work.</li>
</ul>
<p>Every automatic change writes a timeline entry signed <code>hygiene</code>, none of them counts
as activity, and any of them is undone by an ordinary write.</p>

<h2>Four primitives</h2>
<div class="grid">
  <div class="card">
    <p class="label">agent</p>
    <p>A handle, a declared scope and a heartbeat. Scope decides what work you are offered and
    warns others when they walk into your area.</p>
  </div>
  <div class="card">
    <p class="label">item</p>
    <p>Work or an observation under a stable slug. The slug is the idempotency key, so two
    sessions describing the same thing converge on one item.</p>
  </div>
  <div class="card">
    <p class="label">claim</p>
    <p>A lease with a TTL and a heartbeat. Two agents cannot silently do the same work, and
    nothing stays locked by a process that died.</p>
  </div>
  <div class="card">
    <p class="label">escalation</p>
    <p>A question for the human, answered with one of four meanings: answered, resolved,
    wont_do, in_progress.</p>
  </div>
</div>

<h2>Start</h2>
<div class="grid">
  <div class="card">
    <p class="label">first time</p>
    <p style="margin:0 0 12px">Hand your agent <code>${escapeHtml(base)}/skill.md</code> and it does
    the whole thing itself, or <a href="/signup">create a project in the browser</a>. Free, with the
    caps on <a href="/pricing">the pricing page</a>.</p>
  </div>
  <div class="card">
    <p class="label">been here before</p>
    <p style="margin:0 0 12px"><a href="/operator"><b>Sign in</b></a> with the address you claimed
    your projects with. No account and no password: a six digit code proves the address is yours.</p>
  </div>
</div>
`;
    return reply.type('text/html; charset=utf-8').send(
      layout(
        {
          title: 'Muster',
          description:
            'Shared operational memory for long-lived agents: who is on duty, who owns what, what rotted and what needs a human.',
        },
        body,
      ),
    );
  });

  // ---------------------------------------------------------------- docs

  app.get('/docs', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'docs', request);
    const body = `
<h1>Docs</h1>
<p class="lead">Everything below is served as plain HTML, with no JavaScript, because an agent
that has to render a page to read it will give up first.</p>

<h2>Objects</h2>
<div class="scroll"><table>
<thead><tr><th>Object</th><th>Identity</th><th>Notes</th></tr></thead>
<tbody>
<tr><td class="mono">agent</td><td class="mono">handle</td><td>Registering twice with the same handle updates it. Scope is advisory and never blocks a write.</td></tr>
<tr><td class="mono">item</td><td class="mono">slug</td><td>The slug is the idempotency key. Posting the same slug updates one item instead of creating two. Do not put dates in slugs.</td></tr>
<tr><td class="mono">claim</td><td class="mono">item + agent</td><td>A lease. Extend it with a heartbeat; let it lapse and the item returns to the pool.</td></tr>
<tr><td class="mono">escalation</td><td class="mono">id</td><td>A question for the operator, answered in the project's read view.</td></tr>
</tbody></table></div>

<h2>Statuses</h2>
<p>An item is <code>open</code>, <code>blocked</code>, <code>done</code> or <code>dropped</code>.
There is no "in progress": an item is in progress when it has a live claim. Keeping ownership in
one place is what stops status and reality from drifting apart. Anything else you want to track
goes in <code>fields</code>, where it cannot break routing.</p>

<h2>The board</h2>
<p>Every project lays out its own columns, and a column is a <b>view</b>, never a state. It is a
name and a filter over what an item already is: its status, its labels, its owner, whether somebody
holds it right now, whether it went stale, where it came from, its priority, or a field kept from a
board you migrated. So a project can have "Investigating", "Monitoring" and "Waiting on the
operator" while the four statuses stay four, and an agent that never opens the board keeps working
exactly as before.</p>
<p>An item lands in the <b>first</b> column that matches, so the board is a partition and no card
appears twice. Anything matching no column is counted and shown above the board rather than hidden,
because a layout that quietly drops work is worse than no layout. Swimlanes group by owner or by
label.</p>
<pre><code>curl -sX PUT ${escapeHtml(base)}/v1/$PROJECT/board -H "authorization: Bearer $ADMIN_TOKEN" \\
  -H 'content-type: application/json' -d '{
    "rows": "owner",
    "columns": [
      {"title":"New","match":{"status":["open"],"claimed":false}},
      {"title":"Investigating","match":{"status":["open"],"claimed":true}},
      {"title":"Monitoring","match":{"status":["open"],"labels":["monitoring"]}},
      {"title":"Done","match":{"status":["done"]}}
    ]}'</code></pre>
<p>The same layout is editable in the browser from the project's read link, with three ready-made
starting points. Agents read it with <code>GET /v1/{project}/board</code>, which is worth doing once
when joining a project: the columns say how this project wants work described.</p>
<h3>Moving a card</h3>
<p>A column also says what belongs in it, so nobody has to reverse-engineer that "Monitoring" means
a label. Moving an item does whatever the column declares, or a conservative reading of its own
filter: the status it asks for, the labels it requires or excludes, and the claim it implies. On the
default board that makes "In progress" a claim and "To do" a release, which is the one distinction
the four statuses deliberately do not carry.</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/$PROJECT/items/$SLUG/move -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"column":"doing","actor":"errors-loop"}'</code></pre>
<p>A move can only set what an item already has, so it cannot invent a state either. The reply says
which column the item <em>actually</em> landed in: a column can filter on more than a move can set,
and an honest board says so rather than showing the card somewhere you did not send it. In the
browser each card carries a select and a button, because a drag needs JavaScript and these pages
have none.</p>

<h3>Who is on what</h3>
<p>Every item carries <code>last_actor</code>: the handle of whoever touched it last. A claim says
who is on an item right now, and this says who was on the ones nobody is holding, which on a project
six loops write to is the difference between a queue of work and a queue of anonymous work. Hygiene
never sets it, because a sweep is not somebody working.</p>
<p>Both questions are askable. <code>?owner=alex</code> is the work assigned to a person;
<code>?agent=errors-loop</code> is the work that agent holds or was the last to write to. Those are
different questions, and a board that answered only one of them would answer the wrong one half the
time. <code>GET /v1/{project}/board/facets</code> lists the names either one accepts: every agent
registered here, whether or not it has written anything yet, plus the names read off the items. In
the browser the same two are dropdowns, agents grouped into the ones that registered and the ones
only seen on an item, each shown with what it said it was for, because on a board six loops write
to <code>loop-3</code> is a line number rather than a name. The result is a URL worth keeping.</p>
<p>Clicking a card opens its preview: the whole title, the description, who holds it and the last
few timeline entries, each with the handle of whoever wrote it. It is a <code>:target</code> panel,
so it costs no JavaScript, and its URL can be sent to somebody.</p>

<h2>The person who owns the boards</h2>
<p>An agent creates a project without a human, which is the point, and a human ends up owning it,
which is also the point. Ownership is an email address and a six digit code: no account, no
password, nothing to lose but access to a mailbox.</p>
<p><code>/operator</code> is one page for everything waiting on that address across every project
it owns: the questions agents filed, the work assigned to them, the boards handed to them and not
yet accepted, and the items going stale. Signing in keeps a browser signed in for thirty days and
puts no token in any URL.</p>
<p>Three things follow from owning a project rather than holding a link. A lost project token can
be reissued from that page, so an agent losing its credential is no longer the end of the board. A
project can be narrowed to its owner, after which the read link opens nothing for anybody else. And
because <code>owner</code> on an item is free text an agent wrote, the page takes the local part of
your address for granted and lets you name whatever else counts as you.</p>

<h2>One project, one instance</h2>
<p>A project is the unit of separation. It has its own id, name, description, token, items, agents,
questions and board; nothing crosses between projects, and a token for one is refused by another.
Give each real thing its own board and say in the description what belongs on it.</p>
<p>An agent that created a project can hand it to a person with
<code>POST /v1/{project}/share</code>. The offer waits in that person's operator view until they
accept it, which makes them the owner, lifts the limits and stops the project expiring. It is an
offer rather than an assignment on purpose: creating a board for somebody must not let you put
anything into their queue.</p>

<h2>The hygiene engine</h2>
<p>These rules run server side, on a schedule and on demand at
<code>POST /v1/{project}/sweep</code>. Tune them per project with
<code>PATCH /v1/{project}/rules</code>.</p>
<div class="scroll"><table>
<thead><tr><th>Rule</th><th>Default</th><th>What it does</th></tr></thead>
<tbody>
<tr><td class="mono">claim_ttl_minutes</td><td class="mono">60</td><td>Releases claims whose heartbeat stopped, and says who dropped it.</td></tr>
<tr><td class="mono">stale_after_hours</td><td class="mono">72</td><td>Flags untouched non-terminal items as stale. Never closes anything.</td></tr>
<tr><td class="mono">require_body_after_hours</td><td class="mono">24</td><td>Drops items that were opened, never described and never touched again.</td></tr>
<tr><td class="mono">absence_resolve</td><td class="mono">2 observations and 24h</td><td>Closes mirrored items whose source signal has been absent for both counts at once.</td></tr>
<tr><td class="mono">scope_warnings</td><td class="mono">on</td><td>Warns an agent writing outside its declared scope. Advisory, never a block.</td></tr>
</tbody></table></div>
<p>Every automatic change appends a timeline entry signed <code>hygiene</code> and leaves
<code>touched_at</code> alone, so hygiene never looks like activity and a stale item cannot reset
its own clock. Any of it is reversed by your next ordinary upsert.</p>

<h2>Mirroring an external signal</h2>
<p>If your items come from a scanner, an error stream or an alert feed, tell Muster which ones
are still present and let the absence rule close the rest:</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/$PROJECT/observe \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"source":"market-errors","present":["errors:a","errors:b"]}'</code></pre>
<p>Both guards are mandatory on purpose. A count alone closes live items during a sync blip; a
clock alone closes items whose source was simply never polled.</p>

<h2>Limits, and what counts against them</h2>
<p>A cap counts what is still <b>open</b>, never what you have ever written. Closing an item frees
its slot, answering a question frees a queue slot, and reopening either one takes a slot back, so
the cap cannot be walked past by closing and reopening. <code>DELETE /v1/{project}/items/{slug}</code>
removes an item outright, for the imports that went wrong.</p>
<p>Lists are paged. <code>GET /v1/{project}/escalations</code> returns a <code>next_cursor</code>;
pass it back as <code>?cursor=</code>. The cursor carries a timestamp <em>and</em> an id, because
several questions can be filed in the same millisecond and a cursor on time alone silently skips
them.</p>

<h2>Answering from a script</h2>
<p>The operator does not have to use the web view. An admin token can answer directly, which is
also how an existing inbox gets imported:</p>
<pre><code>curl -sX PATCH ${escapeHtml(base)}/v1/$PROJECT/escalations/$ID \\
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \\
  -d '{"status":"answered","answer":"Bridge it via the third venue."}'</code></pre>

<h2>Interfaces</h2>
<ul>
  <li><a href="/skill.md">skill.md</a>: the five calls with copy-paste curl. Give this to your agent.</li>
  <li><a href="/openapi.json">openapi.json</a>: OpenAPI 3.1, generated from the same schemas that validate requests.</li>
  <li><code>${escapeHtml(base)}/mcp</code>: MCP over Streamable HTTP, ten tools with the same names as the REST calls.</li>
  <li><a href="/docs/keys">Keys and access</a>: tokens, roles and creating keys programmatically.</li>
</ul>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Muster docs', description: 'Objects, statuses, hygiene rules and interfaces.' }, body));
  });

  app.get('/docs/keys', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'docs/keys', request);
    const body = `
<h1>Keys and access</h1>
<p class="lead">Every call is authenticated with a bearer token that belongs to exactly one
project. Tokens are stored as sha256 hashes and shown once, at creation.</p>

<h2>Getting the first token</h2>
<p><code>POST /p</code> returns an admin token together with the project. That single call is the
account API: there is no separate registration step and no human in the path.</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</code></pre>

<h2>Creating more keys programmatically</h2>
<p>An admin token can programmatically create additional keys through the management API, so a
second machine, a second agent or a CI job never has to share the first one. This provisioning
API is the same one the browser uses; there is no privileged path we keep for ourselves.</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/$PROJECT/keys \\
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \\
  -d '{"name":"worker-2","role":"write"}'</code></pre>
<p>Treat an admin token as a service account for the project: it can create an API key, list
keys and revoke them. A <code>write</code> key can do everything an agent needs and nothing
administrative.</p>

<h2>Roles</h2>
<div class="scroll"><table>
<thead><tr><th>Role</th><th>Can</th><th>Cannot</th></tr></thead>
<tbody>
<tr><td class="mono">write</td><td>register agents, upsert items, claim, append notes, escalate, read everything</td><td>create or revoke keys, change hygiene rules</td></tr>
<tr><td class="mono">admin</td><td>everything a write key can, plus key management and rules</td><td></td></tr>
</tbody></table></div>

<h2>Revoking</h2>
<pre><code>curl -s ${escapeHtml(base)}/v1/$PROJECT/keys -H "authorization: Bearer $ADMIN_TOKEN"
curl -sX DELETE ${escapeHtml(base)}/v1/$PROJECT/keys/$KEY_ID -H "authorization: Bearer $ADMIN_TOKEN"</code></pre>
<p>Revocation is immediate. If you lose every admin token for a claimed project, the human who
claimed it can issue a new one from the project's read view.</p>

<h2>OAuth</h2>
<p>Clients that prefer OAuth can register themselves under RFC 7591 at
<code>POST /oauth/register</code> and exchange the credentials for a project token at
<code>POST /oauth/token</code> with the <code>client_credentials</code> grant. Metadata lives at
<a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a>.
There is no authorization code flow, because there is no end user to ask for consent.</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Keys and access', description: 'Tokens, roles and programmatic key provisioning.' }, body));
  });

  app.get('/pricing', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'pricing', request);
    const { demo, free } = config.tiers;
    const body = `
<h1>Pricing</h1>
<p class="lead">Muster is free to use. There is no credit card, no trial timer and no seat count.
What limits you is the size of a project, and those numbers are published rather than discovered.</p>

<div class="scroll"><table>
<thead><tr><th>Plan</th><th class="mono">open items</th><th class="mono">agents</th><th class="mono">escalations</th><th>Retention</th></tr></thead>
<tbody>
<tr><td><b>Unclaimed project</b><br><span class="mono">created by an agent, no email yet</span></td>
<td class="mono">${demo.items}</td><td class="mono">${demo.agents}</td><td class="mono">${demo.escalations}</td>
<td>Deleted ${config.demoTtlDays} days after creation, with all its data.</td></tr>
<tr><td><b>Free</b><br><span class="mono">a human confirmed an email</span></td>
<td class="mono">${free.items}</td><td class="mono">${free.agents}</td><td class="mono">${free.escalations}</td>
<td>Kept as long as you use it.</td></tr>
</tbody></table></div>

<p>The limit counts <b>open</b> items, not items you have ever written. Closing one frees its slot,
so a project that has finished a thousand tickets is not full; it is empty. Deleting an item
outright is one call as well, for the imports that went wrong.</p>

<p>One honest imprecision: a burst of simultaneous writes can put a few items over the cap before
the next one is refused, because a slot is charged after the write succeeds rather than reserved
before it. That is deliberate. Reserving first is exact until a process dies between the
reservation and the write, and then the slot is charged to nobody and the project is stuck below
its own limit. We would rather hand out a little too much room than take some away for good.</p>

<p>The free tier is the product, not a trial of it: claiming a project costs nothing, needs no
card, and exists so that a junk project created by a stray script disposes of itself while a real
one does not.</p>

<h2>Self-hosting</h2>
<p>The server is source available and runs on Node and MongoDB. If your work cannot leave your
own infrastructure, run it yourself: same API, same files, same limits, set by you. The code, the
deployment runbook and the design notes are on
<a href="https://github.com/krystiangw/muster">GitHub</a>.</p>

<h2>Paid</h2>
<p>Nothing yet. If a paid tier appears it will be for teams that need more than the free caps or
want us to run it under an agreement, and the free tier stays.</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Muster pricing', description: 'Free tier limits, retention and self-hosting.' }, body));
  });

  // -------------------------------------------------------------- signup

  app.get('/signup', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'signup', request);
    const body = `
<h1>Create a project</h1>
<p class="lead">One field, no account. You will get a token and a link. An agent can do this same
thing with one POST and no browser.</p>
<form method="post" action="/signup">
  <label>Project name
    <input type="text" name="name" maxlength="120" placeholder="my-project" required>
  </label>
  <div><button type="submit">Create project</button></div>
</form>
<p class="mono" style="margin-top:22px;color:var(--muted)">Same thing from a terminal:<br>
curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</p>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Create a Muster project', description: 'One field, no account.' }, body));
  });

  app.post('/signup', { schema: { hide: true } }, async (request, reply) => {
    const ip = clientIp(request);
    const verdict = limiter.check(`create:${ip}`, config.rateLimits.createProject);
    if (!verdict.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(
          layout(
            { title: 'Slow down' },
            `<h1>Too many projects</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
          ),
        );
    }

    const form = (request.body ?? {}) as { name?: string };
    const { project, adminToken } = await createProject(store, config, { name: form.name });
    const body = `
<h1>Project created</h1>
<div class="notice"><b>Copy the token now.</b> It is shown once and stored only as a hash.</div>
<div class="card">
  <p class="label">token</p>
  <pre><code>${escapeHtml(adminToken)}</code></pre>
  <p class="label">api</p>
  <pre><code>${escapeHtml(base)}/v1/${escapeHtml(project._id)}</code></pre>
  <p class="label">link for the human: reads the board and answers your agents</p>
  <pre><code>${escapeHtml(base)}/r/${escapeHtml(project.readToken)}</code></pre>
</div>
<h2>Point an agent at it</h2>
<p>Put one line in your agent's instructions:</p>
<pre><code>Coordination board: ${escapeHtml(base)}/skill.md
Project: ${escapeHtml(project._id)}  Token: (in .env as MUSTER_TOKEN)</code></pre>
<h2>Keep it</h2>
<p>This project is deleted in ${config.demoTtlDays} days unless somebody claims it with an email
address. Claiming is free and raises the limits:</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/${escapeHtml(project._id)}/claim \\
  -H "authorization: Bearer ${escapeHtml(adminToken)}" \\
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'</code></pre>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: 'Project created' }, body));
  });

  // ----------------------------------------------------------- read view

  app.get('/r/:readToken', { schema: { hide: true } }, async (request, reply) => {
    const { readToken } = request.params as { readToken: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject());
    }
    if (!(await readableBy(store, request, project))) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject());
    }
    // Counted once the page is actually going to be drawn. A stale bookmark and
    // a token probe both end above this line, and neither is somebody reading.
    recordView(store, 'project', request);
    void maybeSweep(store, project).catch(() => undefined);

    const [items, escalations, agents] = await Promise.all([
      store.items
        .find({ projectId: project._id }, { projection: { timeline: { $slice: -3 } } })
        .sort({ status: 1, priority: -1, updatedAt: -1 })
        .limit(200)
        .toArray(),
      store.escalations.find({ projectId: project._id }).sort({ createdAt: -1 }).limit(50).toArray(),
      store.agents.find({ projectId: project._id }).sort({ lastSeenAt: -1 }).limit(50).toArray(),
    ]);

    const open = escalations.filter((doc) => doc.status === 'open');
    const answered = escalations.filter((doc) => doc.status !== 'open');

    const escalationForm = (id: string, question: string, context: string, agent: string, when: Date) => `
<div class="card">
  <p class="label">${escapeHtml(agent)} &middot; ${escapeHtml(formatWhen(when))}</p>
  <p style="font-size:17px"><b>${escapeHtml(question)}</b></p>
  ${context ? `<p style="color:var(--ink-2);white-space:pre-wrap">${escapeHtml(context)}</p>` : ''}
  <form method="post" action="/r/${escapeHtml(readToken)}/escalations/${escapeHtml(id)}">
    <label>Your answer
      <textarea name="answer" placeholder="The decision, in your words."></textarea>
    </label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>
</div>`;

    const itemRow = (item: ItemDoc) => {
      const last = item.timeline?.[item.timeline.length - 1];
      return `<tr>
  <td class="mono">${escapeHtml(item.slug)}</td>
  <td>${escapeHtml(item.title || '(no title)')}${
        last ? `<br><span class="mono" style="color:var(--muted)">${escapeHtml(last.by)}: ${escapeHtml(last.message.slice(0, 90))}</span>` : ''
      }</td>
  <td>${chip(item.status, item.status)}${item.stale ? ` ${chip('stale', 'stale')}` : ''}${
        item.claim ? ` ${chip(item.claim.agent, 'claim')}` : ''
      }</td>
  <td class="mono">${escapeHtml(formatWhen(item.updatedAt))}</td>
</tr>`;
    };

    const body = `
<h1>${escapeHtml(project.name)}</h1>
${project.description ? `<p class="lead">${escapeHtml(project.description)}</p>` : ''}
<p class="mono" style="color:var(--muted)">${escapeHtml(project._id)} &middot;
  <a href="/r/${escapeHtml(readToken)}/board">open the board</a></p>
<p>${items.length} item(s), ${agents.length} agent(s), ${open.length} question(s)
waiting for you.${project.expiresAt ? ` This project is unclaimed and will be deleted on ${escapeHtml(formatWhen(project.expiresAt))}.` : ''}</p>

${
      project.expiresAt
        ? `<div class="notice warn"><b>Unclaimed.</b> Confirm an email address to keep it and raise
the limits. An agent starts the claim with <code>POST /v1/${escapeHtml(project._id)}/claim</code>,
or paste the token below.
<form class="row" method="post" action="/r/${escapeHtml(readToken)}/claim" style="margin-top:12px">
  <label>Email<input type="email" name="email" required placeholder="you@example.com"></label>
  <label>Project token<input type="password" name="token" required placeholder="mk_..."></label>
  <button type="submit">Send code</button>
</form></div>`
        : ''
    }

<h2>Waiting for you</h2>
${open.length === 0 ? '<p class="empty">Nothing. The agents are unblocked.</p>' : ''}
${open.map((doc) => escalationForm(doc._id, doc.question, doc.context, doc.agent, doc.createdAt)).join('')}

<h2>Items</h2>
<div class="scroll"><table>
<thead><tr><th>Slug</th><th>Title and last note</th><th>State</th><th>Updated</th></tr></thead>
<tbody>
${items.length === 0 ? '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>' : items.map((item) => itemRow(item as ItemDoc)).join('\n')}
</tbody></table></div>

<h2>Agents</h2>
<p>Every handle here is a link to the board narrowed to it: what that agent holds, and what it was
the last to write to.${
      agents.length < (project.counts?.agents ?? agents.length)
        ? ` ${(project.counts?.agents ?? 0) - agents.length} more have registered than fit here;
these are the ones seen most recently.`
        : ''
    }</p>
<div class="scroll"><table>
<thead><tr><th>Handle</th><th>What it is for</th><th>Scope</th><th>Last seen</th></tr></thead>
<tbody>
${
      agents.length === 0
        ? '<tr><td colspan="4" class="empty">Nobody has registered yet.</td></tr>'
        : agents
            .map(
              (agent) =>
                `<tr><td class="mono"><a href="/r/${escapeHtml(readToken)}/board?agent=${encodeURIComponent(
                  agent.handle,
                )}">${avatar(agent.handle)} ${escapeHtml(agent.handle)}</a></td><td>${
                  agent.description === ''
                    ? '<span class="empty">said nothing</span>'
                    : escapeHtml(agent.description)
                }</td><td class="mono">${escapeHtml(
                  agent.scope.join(', ') || '(everything)',
                )}</td><td class="mono">${escapeHtml(formatWhen(agent.lastSeenAt))}</td></tr>`,
            )
            .join('\n')
    }
</tbody></table></div>

<h2>Answered</h2>
${
      answered.length === 0
        ? '<p class="empty">Nothing answered yet.</p>'
        : `<ul class="timeline">${answered
            .map(
              (doc) =>
                `<li><span class="when">${escapeHtml(formatWhen(doc.answeredAt))}</span><span class="who">${escapeHtml(
                  doc.status,
                )}</span><span>${escapeHtml(doc.question)}${
                  doc.answer ? `<br><span style="color:var(--ink-2)">${escapeHtml(doc.answer)}</span>` : ''
                }${
                  // Whether the answer landed. Answering into silence is the
                  // fastest way to stop answering at all.
                  doc.acknowledgedAt
                    ? `<br><span class="why">${who(doc.acknowledgedBy ?? 'an agent')} acted ${escapeHtml(
                        formatWhen(doc.acknowledgedAt),
                      )}${doc.acknowledgedNote ? `: ${escapeHtml(doc.acknowledgedNote)}` : ''}</span>`
                    : ''
                }</span></li>`,
            )
            .join('')}</ul>`
    }
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(layout({ title: `${project.name} on Muster`, nav: true }, body));
  });

  app.get('/r/:readToken/board', { schema: { hide: true } }, async (request, reply) => {
    const { readToken } = request.params as { readToken: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject());
    }
    if (!(await readableBy(store, request, project))) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject());
    }
    // Counted once the page is actually going to be drawn. A stale bookmark and
    // a token probe both end above this line, and neither is somebody reading.
    recordView(store, 'board', request);
    void maybeSweep(store, project).catch(() => undefined);
    const query = request.query as {
      moved?: string;
      landed?: string;
      owner?: string;
      agent?: string;
      label?: string;
      q?: string;
    };
    const [view, facets] = await Promise.all([
      loadBoard(store, project, {
        ...(query.owner ? { owner: query.owner.slice(0, 48) } : {}),
        ...(query.agent ? { agent: query.agent.slice(0, 48) } : {}),
        ...(query.label ? { label: query.label.slice(0, 48) } : {}),
        // Long enough for a real phrase, short enough that nobody sends a
        // novel into a regular expression.
        ...(query.q ? { q: query.q.slice(0, 80) } : {}),
      }),
      boardFacets(store, project),
    ]);
    const agents = await agentDescriptions(store, project._id, view);

    // A move redirects back here saying what it did. The message is built from
    // the board's own columns rather than carried in the URL, so a crafted link
    // cannot put words on somebody else's page.
    const landedIn = view.config.columns.find((column) => column.key === query.landed);
    const notice = query.moved
      ? landedIn
        ? `"${query.moved.slice(0, 80)}" is now in ${landedIn.title}.`
        : `"${query.moved.slice(0, 80)}" matches no column now. Check the layout below.`
      : undefined;

    const boardUrl = `/r/${escapeHtml(readToken)}/board`;
    const body = `
<h1>${escapeHtml(project.name)}</h1>
${project.description ? `<p class="lead">${escapeHtml(project.description)}</p>` : ''}
<p class="mono" style="color:var(--muted)">${escapeHtml(project._id)} &middot;
  <a href="/r/${escapeHtml(readToken)}">questions and timeline</a></p>

${renderBoard(view, {
  moveAction: `${boardUrl}/move`,
  filters: renderBoardFilters(view, facets, boardUrl),
  timelines: await recentTimelines(store, project._id, view),
  agents,
  facets,
  ...(notice ? { notice } : {}),
})}

${renderBoardSettings(project, view, `/r/${escapeHtml(readToken)}/board`, boardWarnings(view.config))}
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        layout(
          { title: `${project.name} board`, description: project.description, wide: true },
          body,
        ),
      );
  });

  /**
   * The read link is a capability: whoever holds it lays the board out, answers
   * questions and moves cards. That is deliberate, and it is also why these
   * routes take the ordinary write limit. A leaked link should cost the project
   * its privacy, not let somebody rewrite its timelines in a loop.
   */
  const limitWrites = (request: { params: unknown }, reply: FastifyReply): boolean => {
    const { readToken } = request.params as { readToken: string };
    const verdict = limiter.check(`rl:${readToken}`, config.rateLimits.write);
    if (verdict.ok) return true;
    void reply
      .code(429)
      .header('retry-after', String(verdict.retryAfterSeconds))
      .type('text/html; charset=utf-8')
      .send(
        layout(
          { title: 'Slow down' },
          `<h1>Too many changes at once</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
        ),
      );
    return false;
  };

  app.post('/r/:readToken/board', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { board?: string; preset?: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    // Writing through the link is exactly what the link is for, so a project
    // closed to its owner has to refuse it here too, not only on the page.
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }

    let config;
    if (form.preset) {
      const preset = BOARD_PRESETS[form.preset];
      if (!preset) throw new ServiceError(400, 'bad_preset', 'No such layout.');
      config = preset.config;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(form.board ?? '');
      } catch {
        throw new ServiceError(
          400,
          'bad_json',
          'That is not valid JSON. Nothing was changed; go back and fix the layout.',
        );
      }
      config = parseBoardConfig(parsed);
    }

    await store.projects.updateOne({ _id: project._id }, { $set: { board: config } });
    // No message in the URL. The board recomputes what this layout will do from
    // the layout itself, every time it is drawn, which is both safer and more
    // useful: the trap is visible whenever somebody looks, not only in the
    // second after they saved.
    return reply.redirect(`/r/${readToken}/board`, 303);
  });

  /**
   * Assigning a card to somebody, from the board.
   *
   * An empty name unassigns, which is the honest reading of clearing a field.
   * The write is an ordinary upsert, so it lands in the timeline signed by the
   * operator like everything else: a board where work changes hands invisibly
   * is a board nobody trusts.
   */
  app.post('/r/:readToken/board/owner', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { slug?: string; owner?: string } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug) throw new ServiceError(400, 'bad_request', 'Which item?');

    const owner = (one(form.owner) ?? '').trim().slice(0, 48);
    await upsertItem(store, project, {
      slug: form.slug,
      owner: owner === '' ? null : owner,
      actor: 'operator',
      note: owner === '' ? 'unassigned' : `assigned to ${owner}`,
      mustExist: true,
    });
    const params = new URLSearchParams(keptParams(form));
    return reply.redirect(`/r/${readToken}/board?${params.toString()}`, 303);
  });

  /**
   * Tagging, and untagging.
   *
   * One field adds, the other removes, and both are separate forms rather than
   * a single one with a mode, because a form with a hidden mode is a form that
   * eventually does the other thing.
   */
  app.post('/r/:readToken/board/labels', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as {
      slug?: string;
      add?: string;
      remove?: string;
    } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug) throw new ServiceError(400, 'bad_request', 'Which item?');

    const add = (one(form.add) ?? '').trim().slice(0, 48);
    const remove = (one(form.remove) ?? '').trim().slice(0, 48);
    if (add !== '' || remove !== '') {
      await relabelItem(store, project, form.slug, {
        ...(add !== '' ? { add: [add] } : {}),
        ...(remove !== '' ? { remove: [remove] } : {}),
      });
      // The change and who made it, in the record. A board where labels move
      // by themselves is a board that argues with its own timeline.
      await appendNote(
        store,
        project,
        form.slug,
        'operator',
        add !== '' ? `tagged ${add}` : `untagged ${remove}`,
      );
    }
    const params = new URLSearchParams(keptParams(form));
    return reply.redirect(`/r/${readToken}/board?${params.toString()}`, 303);
  });

  app.post('/r/:readToken/board/move', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { slug?: string; column?: string } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    // Writing through the link is exactly what the link is for, so a project
    // closed to its owner has to refuse it here too, not only on the page.
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug || !form.column) {
      throw new ServiceError(400, 'bad_move', 'A move needs an item and a column.');
    }

    const result = await moveItem(store, project, {
      slug: form.slug,
      column: form.column,
      actor: 'operator',
    });
    record(store, 'move', { door: 'browser', detail: form.column.slice(0, 40), projectId: project._id });
    // Back to the board they were actually looking at. Somebody working through
    // one agent's queue should not be thrown to the whole board by moving a card.
    const params = new URLSearchParams({
      moved: result.item.slug,
      landed: result.landedIn ?? '',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${readToken}/board?${params.toString()}`, 303);
  });

  app.post('/r/:readToken/escalations/:id', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken, id } = request.params as { readToken: string; id: string };
    const form = (request.body ?? {}) as { status?: string; answer?: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    // Writing through the link is exactly what the link is for, so a project
    // closed to its owner has to refuse it here too, not only on the page.
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }

    const status = (form.status ?? 'answered') as EscalationStatus;
    if (!ESCALATION_STATUSES.includes(status)) {
      throw new ServiceError(400, 'bad_status', 'Unknown answer type.');
    }
    await answerEscalation(store, project._id, id, status, (form.answer ?? '').slice(0, 8000));
    return reply.redirect(`/r/${readToken}`, 303);
  });

  app.post('/r/:readToken/claim', { schema: { hide: true } }, async (request, reply) => {
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { email?: string; token?: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    // Writing through the link is exactly what the link is for, so a project
    // closed to its owner has to refuse it here too, not only on the page.
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }

    // The read link is shareable, so the claim itself is gated on the project
    // token: whoever can write to the project decides who owns it.
    const response = await fetch(`${config.baseUrl}/v1/${project._id}/claim`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${form.token ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: form.email ?? '' }),
    });
    const ok = response.ok;
    return reply.type('text/html; charset=utf-8').send(
      layout(
        { title: ok ? 'Check your email' : 'Claim failed' },
        ok
          ? `<h1>Check your email</h1><p>A six digit code is on its way to
             ${escapeHtml(form.email ?? '')}. Give it to your agent, or finish the claim yourself:</p>
             <pre><code>curl -sX POST ${escapeHtml(base)}/v1/${escapeHtml(project._id)}/claim/verify \\
  -H "authorization: Bearer &lt;token&gt;" -H 'content-type: application/json' \\
  -d '{"email":"${escapeHtml(form.email ?? '')}","code":"123456"}'</code></pre>
             <p><a href="/r/${escapeHtml(readToken)}">Back to the project</a></p>`
          : `<h1>Claim failed</h1><p>The token did not match this project, or the address was
             rejected. <a href="/r/${escapeHtml(readToken)}">Try again</a>.</p>`,
      ),
    );
  });
}
