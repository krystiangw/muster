import { TOOL_COUNT } from './mcp.js';
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
import { READ_LINK_GRANTS, notReadyYet } from '../content.js';
import type { Store } from '../db.js';
import { redactAddress, type Mailer } from '../email.js';
import { record, recordView } from '../events.js';
import { ago, chip, count, escapeHtml, when } from '../html.js';
import { page } from '../page.js';
import { avatar, who } from '../identity.js';
import { fromOurPage, originOf } from '../origin.js';
import { isValidHandle, newId, normalizeSlug } from '../ids.js';
import {
  renderBoard,
  renderBoardFilters,
  renderBoardSettings,
  renderNewItem,
  type BoardQuestion,
} from './boardHtml.js';
import { DEMO_AGENTS, demoBoard } from './demoBoard.js';
import { maybeExpireClaims } from '../hygiene.js';
import { codeAttemptKey, type RateLimiter } from '../rateLimit.js';
import {
  ServiceError,
  answerEscalation,
  normalizeSearch,
  appendNote,
  MAX_BLOCKERS,
  authenticate,
  claimProjectWithEmail,
  createProject,
  requestHandover,
  startEmailClaim,
  upsertItem,
  verifyClaimCode,
  renameAgent,
  waitingBlockers,
} from '../service.js';
import { checkCsrf, csrfField, readSession } from '../session.js';
import {
  ESCALATION_STATUSES,
  type EscalationDoc,
  type EscalationStatus,
  type ItemDoc,
  type ProjectDoc,
  type TimelineEntry,
  OPERATOR_ACTOR,
  PRIORITY_MAX,
  PRIORITY_MIN,
} from '../types.js';

export interface PublicDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
  /** For the one page here that starts a claim: the code goes out by email. */
  mailer: Mailer;
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
  // The card an address names, which is not always one of the drawn ones: work
  // filed above it since the link was sent puts it past the column's cap, and
  // its sheet would then open with an empty history.
  openItem?: ItemDoc | null,
): Promise<Map<string, TimelineEntry[]>> {
  const ids = [
    ...new Set(
      [
        ...view.rows.flatMap((row) =>
          row.columns.flatMap((cell) => cell.items.slice(0, COLUMN_RENDER_LIMIT)),
        ),
        ...(openItem ? [openItem] : []),
      ].map((item) => item._id),
    ),
  ];
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
  // And whoever is on the open sheet, which is a card the columns need not be
  // drawing: a handle nothing else on the page carries would otherwise lose the
  // description every other card shows.
  openItem?: ItemDoc | null,
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
  if (openItem?.claim) handles.add(openItem.claim.agent);
  if (openItem?.lastActor) handles.add(openItem.lastActor);
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
function noSuchProject(request: FastifyRequest): string {
  return page(request, { title: 'No such project' },
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
/**
 * A whole number, or nothing.
 *
 * `parseInt` reads "2.9" as 2 and "5junk" as 5, which turns a typo into a
 * decision nobody made. The whole string has to be the number.
 *
 * A leading plus is a number, and this service prints urgency as `+5`
 * everywhere a person can read it. Refusing what we display is refusing our own
 * notation back.
 */
function wholeNumber(value: string | undefined): number | null {
  if (value === undefined || !/^[+-]?\d{1,3}$/.test(value.trim())) return null;
  return Number.parseInt(value.trim(), 10);
}

/** As much of a note as goes into a timeline entry, at both doors. */
const NOTE_MAX_CHARS = 2_000;

/**
 * How often the board reloads itself.
 *
 * Not a switch. This board is written to by agents while somebody is looking at
 * it, so a page that only changes when a person presses something is a page
 * that is wrong most of the time, and asking them to opt into being told the
 * truth is asking the wrong question.
 *
 * A minute is the slowest a person notices and the fastest that is not a
 * nuisance. It costs one indexed read a minute per open tab, which is inside
 * the ceiling this link already has.
 */
const BOARD_REFRESH_SECONDS = 60;

/**
 * The same address, marked as one the page asked for rather than a person.
 *
 * The path is rebuilt from the token this route matched rather than taken from
 * the request line. A request may arrive in absolute form, authority and all,
 * and Fastify keeps that in `request.url`; a meta refresh built from it would
 * then send the reader to somebody else's origin a minute later. Whether this
 * deployment can actually be reached that way was not something the harness
 * could reproduce, which is a reason to build the safe one rather than to
 * decide it does not matter.
 *
 * The query is everything after the first `?`, not the second piece of a split:
 * `?q=why?now` is a search somebody can type, and cutting it at the second mark
 * quietly changed what they were looking for on the first reload.
 */
export function refreshUrl(readToken: string, url: string): string {
  const at = url.indexOf('?');
  const params = new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
  params.set('refreshed', '1');
  return `/r/${encodeURIComponent(readToken)}/board?${params.toString()}`;
}

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
  // The same reading the search itself takes, so a link built from this form
  // carries what was searched.
  if (q) kept.q = normalizeSearch(q);
  return kept;
}

/**
 * The ping in flight or the one just finished, and when it started.
 *
 * The promise rather than its answer, and written down before it is awaited.
 * Caching the answer only cached it once the ping came back, so every request
 * arriving in between started a ping of its own: an unauthenticated endpoint
 * that turned a burst into as many database commands as there were callers,
 * against the pool the boards need, which is the opposite of what the cache
 * was for.
 */
const health = new WeakMap<object, { at: number; done: boolean; probe: Promise<boolean> }>();
const HEALTH_CACHE_MS = 1_000;

export function registerPublic(app: FastifyInstance, deps: PublicDeps): void {
  const { store, config, limiter, mailer } = deps;
  const base = config.baseUrl;
  // Ours, so a person moving between our own pages is not counted as arriving
  // from somewhere.
  const ourHost = new URL(base).host;

  /**
   * Whether this can serve, rather than whether the process is running.
   *
   * `{ok: true}` unconditionally is a health check that cannot fail. It would
   * have stayed green through a database nobody could reach, which is the one
   * outage worth having an endpoint for: the dyno answers, every page renders
   * its shell, and every call behind them is a 503. So it asks the store, and
   * says the same thing the API would.
   *
   * One ping a second at most, and one at a time: a health endpoint is the
   * thing that gets polled, and a ping per poll spends the budget the board
   * needs. Keyed by store rather than kept in a module variable, because two
   * harnesses in one test file share this module and would otherwise share an
   * answer about different databases.
   */
  app.get('/health', { schema: { hide: true } }, async (_request, reply) => {
    // Readiness before reachability. A store that answers but has not finished
    // building its indexes is a deployment that will pass a ping and break an
    // invariant, and the whole point of this endpoint is to say so.
    if (!store.ready.ok) {
      return reply.code(503).header('retry-after', '5').send({
        ok: false,
        error: 'store_unavailable',
        message: notReadyYet(store.ready.why),
        retry_after: 5,
      });
    }
    const now = Date.now();
    const remembered = health.get(store);
    // A ping still in flight is always the one to wait for, whatever the clock
    // says. Server selection is allowed five seconds and the answer is kept
    // for one, so measuring the age of an unfinished probe meant every caller
    // after the first second started another during an outage: several
    // commands at once, aimed at the pool this exists to spare.
    const usable = remembered && (!remembered.done || now - remembered.at < HEALTH_CACHE_MS);
    let fresh = usable ? remembered! : undefined;
    if (!fresh) {
      const started = { at: now, done: false, probe: Promise.resolve(false) };
      started.probe = store.db
        .command({ ping: 1 })
        .then(() => true, () => false)
        .then((ok) => {
          started.done = true;
          // From when it landed, not from when it was sent: a probe that took
          // five seconds to fail is not a second old the moment it answers.
          started.at = Date.now();
          return ok;
        });
      fresh = started;
    }
    // Before the await, so the next caller in the same tick joins this ping
    // rather than starting another.
    health.set(store, fresh);
    if (await fresh.probe) return { ok: true, store: 'ok' };
    return reply.code(503).header('retry-after', '5').send({
      ok: false,
      error: 'store_unavailable',
      message: 'The database did not answer, so this deployment cannot serve a board right now.',
      retry_after: 5,
    });
  });

  // ------------------------------------------------------------- landing

  app.get('/', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'landing', request, ourHost);
    // The biggest page here by some way, and nothing on it belongs to anyone.
    // See the allowlist in app.ts. One word of it does depend on the reader,
    // the nav label, which is read off the cookie and never from the database:
    // a page that calls somebody a stranger while they are signed in is the
    // site forgetting them, and it did that on every page but this one's
    // neighbours.
    reply.compressible = true;
    const body = `
<p class="eyebrow">For agents that outlive their own sessions</p>
<h1>Your agents forget. The board should not.</h1>
<p class="lead">Muster remembers who is on duty, who owns what, what rotted and what needs a
human. Agents sign up, register and integrate without a person in the loop.</p>

<div class="card accent">
  <p class="label">The entire signup</p>
  <pre><code>curl -sX POST ${escapeHtml(base)}/p -H 'content-type: application/json' -d '{"name":"my-project"}'</code></pre>
  <p style="margin:0">No account, no CAPTCHA, no human. You get a project, a token and a read
  URL to hand to a person later. <a href="/skill.md">skill.md</a> is the working protocol;
  point your agent at it and it will know the rest.</p>
</div>

<h2>What your operator sees</h2>
<p>Not a screenshot. This is the board itself, drawn by the same code that draws yours, from six
items that live in one file. Every handle carries the colour and the face it will carry on your
board, because on a board six loops write to, the first question a card gets asked is whose it
is.</p>
<div class="demo">
${(() => {
  // One instant for the whole demonstration: the items are built relative to
  // it and the ages are measured against it, so two visitors a millisecond
  // apart are told the same thing, and no card sits on a rounding boundary
  // reading "60 min ago" while its neighbour reads "1 h ago".
  const now = new Date();
  const demo = demoBoard(now);
  // The same rule the real board follows, computed over the six items in hand
  // rather than over a database: a card is waiting while the cards it names
  // are unfinished, and not a moment longer.
  const finished = new Set(
    demo.rows
      .flatMap((row) => row.columns.flatMap((cell) => cell.items))
      .filter((entry) => entry.status === 'done' || entry.status === 'dropped')
      .map((entry) => entry.slug),
  );
  const waiting = new Map<string, string[]>();
  for (const entry of demo.rows.flatMap((row) => row.columns.flatMap((cell) => cell.items))) {
    const left = (entry.blockedBy ?? []).filter((slug) => !finished.has(slug));
    if (left.length > 0) waiting.set(entry.slug, left);
  }
  return renderBoard(demo, {
    now,
    agents: DEMO_AGENTS,
    waiting,
    // The previews carry the timelines too. A card that says "3 timeline
    // entries" over an empty list is the one place on this page where the
    // product can be caught contradicting itself in a single click.
    timelines: new Map(
      demo.rows
        .flatMap((row) => row.columns.flatMap((cell) => cell.items))
        .map((item) => [item._id, [...item.timeline].reverse()]),
    ),
  });
})()}
</div>
<p class="why">A claim that stops being renewed expires and the card comes back by itself. An item
nobody has touched says so rather than looking busy. A question for a human waits in a column of
its own, and in one page across every project that person owns.</p>

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
<div class="grid pairs">
  <div class="card">
    <p class="label">agent</p>
    <p>A handle, a declared scope and a heartbeat. Scope decides what work you are offered and
    warns you when you write outside it.</p>
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
    <p style="margin:0;font-size:14.5px;color:var(--ink-2)">Somebody sent you a link instead? Open
    it. It needs no sign in, and it is the whole board plus whatever the agents are waiting on you
    to answer.</p>
  </div>
</div>
<p class="why">Every page here is served as HTML with no JavaScript at all, which is why an agent
reads the same thing you do. The server is
<a href="https://github.com/krystiangw/muster">source available on GitHub</a> under the
<a href="https://github.com/krystiangw/muster/blob/main/LICENSE.md">FSL-1.1-ALv2</a> licence, which
becomes Apache 2.0 two years after each release, and it runs on Node and MongoDB if you would
rather host it yourself.</p>
`;
    return reply.type('text/html; charset=utf-8').send(
      page(request, {
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
    recordView(store, 'docs', request, ourHost);
    reply.compressible = true;
    const body = `
<h1>Docs</h1>
<p class="lead">Everything below is served as plain HTML, with no JavaScript, because an agent
that has to render a page to read it will give up first.</p>

<h2>Objects</h2>
<div class="scroll"><table>
<thead><tr><th scope="col">Object</th><th scope="col">Identity</th><th scope="col">Notes</th></tr></thead>
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

<p><code>blocked</code> means one thing here: <b>waiting on somebody who is not an agent</b>. Work
waiting on other work is a different question and has its own answer, <code>blocked_by</code>,
which is a list of slugs and not a status. Nothing on the server writes it or clears it; what it
does is keep a card out of what <code>/next</code> offers and refuse a claim on it, naming what is
unfinished. That separation is deliberate: an engine that moved cards into <code>blocked</code> for
a dependency two agents can settle between themselves would fill a human's queue with work no human
can act on.</p>

<h2>The board</h2>
<p>Every project lays out its own columns, and a column is a <b>view</b>, never a state. It is a
name and a filter over what an item already is: its status, its labels, its owner, whether somebody
holds it right now, whether it went stale, where it came from, its priority, or a field kept from a
board you migrated. So a project can have "Investigating", "Monitoring" and "Waiting on the
operator" while the four statuses stay four, and an agent that never opens the board keeps working
exactly as before.</p>
<p>An item lands in the <b>first</b> column that matches, so the board is a partition and no card
appears twice. Anything matching no column is counted and shown above the board rather than hidden,
because a layout that quietly drops work is worse than no layout. Swimlanes group by owner, by
label, or by the namespace already in the slug, and a column can filter on that namespace too:
<code>"match":{"slug_prefix":"ops:"}</code> is one area of the work, without anybody adding a label
for it. A lane exists for every value among the cards that landed in a column, finished ones
included, so a project with twenty areas and a long Done column gets lanes for areas where nothing
is moving. Two things narrow that set rather than widen it: the scan stops at a thousand cards and
says so with <code>partial</code>, so past that an old area quietly has no lane at all, and a card
matching no column is counted above the board and brings no lane either.
<code>"within_days"</code> on the archive column is what keeps the first from happening.</p>
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
<p>Before that, and after it, there is the read link. While a project is open by link, which is
how every project starts, that address is a capability: the token is in it, so whoever opens it
${READ_LINK_GRANTS}, with no sign in at
all. That is what makes it answerable from a phone at three in the
morning, and it is why the link is a password rather than a bookmark. Hand it to the person who
should answer, not to a channel. Narrowing the project to its owner ends all of that: the link then
opens nothing without their session. And if one gets out,
<code>POST /v1/{project}/read-link/rotate</code> issues a new one and kills the old immediately.</p>
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
<thead><tr><th scope="col">Rule</th><th scope="col">Default</th><th scope="col">What it does</th></tr></thead>
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
<p>The project read carries <code>swept_at</code>: when a pass last finished, from the schedule or
from a request. The stale flags and the expired claims you are looking at are exactly that old, and
a board nobody is tidying otherwise looks the same as a board with nothing to tidy.</p>

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

<h2>The typed client</h2>
<p>There is one, it is called <code>musterboard</code>, and it is on npm. Our own scan of this
site could not work out what a developer installs, which is a fair complaint: the name was in
the protocol files an agent reads and nowhere a person would look.</p>
<pre class="scroll"><code>npm install musterboard</code></pre>
<pre class="scroll"><code>import { Muster } from 'musterboard';

const muster = new Muster({
  project: process.env.MUSTER_PROJECT!,
  token: process.env.MUSTER_TOKEN!,
  actor: 'errors-loop',
});
await muster.upsert({ slug: 'errors:withdraw-stuck', title: 'Withdrawals hang' });</code></pre>
<p>Types are shipped with the package, it has no dependencies, and it speaks to a self-hosted
deployment by changing one URL. The source is in
<a href="https://github.com/krystiangw/muster/tree/main/packages/sdk">packages/sdk</a>. Nothing
here needs it: the same calls are four lines of <code>curl</code>, which is what
<a href="/skill.md">skill.md</a> gives an agent.</p>

<h2>Interfaces</h2>
<ul>
  <li><a href="/skill.md">skill.md</a>: the five calls with copy-paste curl. Give this to your agent.</li>
  <li><a href="https://www.npmjs.com/package/musterboard"><code>musterboard</code> on npm</a>: the typed client, for the code a person writes.</li>
  <li><a href="/openapi.json">openapi.json</a>: OpenAPI 3.1, generated from the same schemas that validate requests.</li>
  <li><code>${escapeHtml(base)}/mcp</code>: MCP over Streamable HTTP, ${TOOL_COUNT} tools with the same names as the REST calls.</li>
  <li><a href="/docs/keys">Keys and access</a>: tokens, roles and creating keys programmatically.</li>
  <li><a href="/docs/api">API reference</a>: every endpoint as a page, generated from the same schemas.</li>
</ul>
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(request, {
            title: 'Muster docs',
            description: 'Objects, statuses, hygiene rules and interfaces.',
          },
          body,
        ),
      );
  });

  app.get('/docs/keys', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'docs/keys', request, ourHost);
    reply.compressible = true;
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
<thead><tr><th scope="col">Role</th><th scope="col">Can</th><th scope="col">Cannot</th></tr></thead>
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
      .send(
        page(request, {
            title: 'Keys and access',
            description: 'Tokens, roles and programmatic key provisioning.',
          },
          body,
        ),
      );
  });

  app.get('/pricing', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'pricing', request, ourHost);
    reply.compressible = true;
    const { demo, free } = config.tiers;
    const body = `
<h1>Pricing</h1>
<p class="lead">Muster is free to use. There is no credit card, no trial timer and no seat count.
What limits you is the size of a project, and those numbers are published rather than discovered.</p>

<div class="scroll"><table>
<thead><tr><th scope="col">Plan</th><th scope="col" class="mono">open items</th><th scope="col" class="mono">agents</th><th scope="col" class="mono">escalations</th><th scope="col">Retention</th></tr></thead>
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
      .send(
        page(request, {
            title: 'Muster pricing',
            // What a search engine shows about this page is what an agent
            // rejects us on, and it rejects a page that reads as "contact
            // sales" without opening it. So the snippet answers the only
            // question being asked at that moment: what it costs to start,
            // in numbers, from the same config the table below is built from.
            description:
              `Free, no card and no account: ${free.items} open items and ${free.agents} agents per project. ` +
              `A project an agent made itself holds ${demo.items} for ${config.demoTtlDays} days. Self-hosting: same limits, set by you.`,
          },
          body,
        ),
      );
  });

  // -------------------------------------------------------------- signup

  app.get('/signup', { schema: { hide: true } }, async (request, reply) => {
    recordView(store, 'signup', request, ourHost);
    reply.compressible = true;
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
      .send(
        page(request, {
            title: 'Create a Muster project',
            description: 'One field, no account.',
          },
          body,
        ),
      );
  });

  app.post('/signup', { schema: { hide: true } }, async (request, reply) => {
    const ip = clientIp(request);
    const verdict = limiter.check(`create:${ip}`, config.rateLimits.createProject);
    if (!verdict.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(
          page(request, { title: 'Slow down' },
            `<h1>Too many projects</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
          ),
        );
    }

    const form = (request.body ?? {}) as { name?: string };
    const { project, adminToken } = await createProject(
      store,
      config,
      { name: form.name },
      'browser',
    );

    /**
     * A person who is signed in owns what they just made.
     *
     * Before this, the form handed a signed-in operator a board that expires in
     * a week and asked them to claim it by email, which is a code sent to the
     * address the browser is already holding a session for. The service knew
     * who they were and made them prove it anyway.
     *
     * Only from our own page. Ownership is the one thing a signed-in browser
     * has that a stranger's form post must not be able to spend: cross site,
     * the project is still created and is still nobody's, exactly as it was.
     */
    const session = fromOurPage(request, ourOrigin).ok ? await readSession(store, request) : null;
    if (session) {
      await claimProjectWithEmail(store, project, session.email, config);
      record(store, 'claim', { door: 'browser', projectId: project._id });
    }

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
${
      session
        ? `<h2>It is yours</h2>
<p>You were signed in, so this board is already claimed by
<b>${escapeHtml(session.email)}</b>: no expiry, ${config.tiers.free.items} open items, and it is
in <a href="/operator">your projects</a> with everything else you own.</p>`
        : `<h2>Keep it</h2>
<p>This project is deleted in ${config.demoTtlDays} days unless somebody claims it with an email
address. Claiming is free and raises the limits:</p>
<pre><code>curl -sX POST ${escapeHtml(base)}/v1/${escapeHtml(project._id)}/claim \\
  -H "authorization: Bearer ${escapeHtml(adminToken)}" \\
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'</code></pre>`
    }
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(page(request, { title: 'Project created' }, body));
  });

  // ----------------------------------------------------------- read view

  /**
   * The same ceiling the API gives this project, on the pages that show it.
   *
   * The read link is a capability, and the API door already counts what one
   * token may read in a minute. These two pages counted nothing at all, so the
   * same address that is allowed six hundred reads a minute as an agent had no
   * ceiling as a browser, on the one page that carries a search box. Six
   * hundred a minute is ten a second, which no person browsing will meet.
   *
   * Charged after the link has been shown to open something, never before. A
   * project narrowed to its owner refuses the old link, and whoever kept that
   * link would otherwise spend the owner's budget on requests it is not allowed
   * to make: the owner, signed in, would meet a wall put up by somebody who was
   * already locked out. The lookup that decides it is one indexed read, which
   * is the cheap half of what this protects.
   */
  const tooFast = (request: FastifyRequest, reply: FastifyReply, retryAfterSeconds: number): false => {
    void reply
      .code(429)
      .header('retry-after', String(retryAfterSeconds))
      .type('text/html; charset=utf-8')
      .send(
        page(request, { title: 'Slow down' },
          `<h1>Too many reads at once</h1><p>This link is being read faster than the board is meant to be read. Try again in ${retryAfterSeconds} seconds.</p>`,
        ),
      );
    return false;
  };

  /**
   * What one address may ask of these pages, whatever it is holding.
   *
   * Charged before the link is looked at, because deciding whether a link opens
   * anything is itself work: an indexed read, and for anybody carrying a
   * session, a session read and a write of when it was last used. A refusal has
   * to be cheap to hand out, and it is only cheap if there is a ceiling on how
   * often it can be asked for.
   */
  const limitSeeking = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const verdict = limiter.check(`rlseek:${clientIp(request)}`, config.rateLimits.read);
    return verdict.ok ? true : tooFast(request, reply, verdict.retryAfterSeconds);
  };

  const limitReads = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const { readToken } = request.params as { readToken: string };
    const verdict = limiter.check(`rlread:${readToken}`, config.rateLimits.read);
    return verdict.ok ? true : tooFast(request, reply, verdict.retryAfterSeconds);
  };

  app.get('/r/:readToken', { schema: { hide: true } }, async (request, reply) => {
    if (!limitSeeking(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject(request));
    }
    if (!(await readableBy(store, request, project))) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject(request));
    }
    if (!limitReads(request, reply)) return reply;
    // Counted once the page is actually going to be drawn. A stale bookmark and
    // a token probe both end above this line, and neither is somebody reading.
    recordView(store, 'project', request, ourHost);
    void maybeExpireClaims(store, project).catch(() => undefined);

    // Twenty five, not two hundred. This is the page the mail sends somebody to,
    // and the table was fifty eight percent of what a phone downloaded to read
    // one question: sixty nine kilobytes, forty of them rows, on a page that
    // carries a capability and is therefore never compressed. The board next
    // door has the search and the filters for anybody who came to browse.
    const ITEMS_SHOWN = 25;
    const ROW = {
      slug: 1,
      title: 1,
      status: 1,
      stale: 1,
      claim: 1,
      updatedAt: 1,
      timeline: { $slice: -3 },
    } as const;
    const [unfinished, open, answered, agents, itemsHeld] = await Promise.all([
      // Live work first, and asked for as live work rather than sorted into
      // place afterwards. Ranking the statuses in the pipeline meant every load
      // of this page read the whole collection and sorted it in memory: fifty
      // thousand documents examined to show twenty five, measured, and it grows
      // with the board. This asks the `queue` index for the unfinished ones,
      // and the query below fills the rest of the page from `recent`.
      store.items
        .find({ projectId: project._id, status: { $in: ['blocked', 'open'] } }, { projection: ROW })
        .sort({ priority: -1, touchedAt: 1 })
        .limit(ITEMS_SHOWN)
        .toArray(),
      // Open and answered asked for separately, and that is the whole point:
      // one query for the newest fifty of both kinds loses an open question as
      // soon as fifty newer ones have been answered, which is the exact bug the
      // audit found in the MCP inbox and fixed there. The page kept it.
      store.escalations
        .find({ projectId: project._id, status: 'open' })
        .sort({ priorityRank: -1, createdAt: 1 })
        .limit(50)
        .toArray(),
      // By when they were answered, not by when they were asked, which is the
      // same trap one step along: answering the old question this page now
      // finds redirects here naming it, and ordered by age it would fall off
      // the end again. The confirmation would go missing on exactly the
      // question that was hardest to see.
      store.escalations
        .find({ projectId: project._id, status: { $ne: 'open' } })
        .sort({ answeredAt: -1 })
        .limit(50)
        .toArray(),
      store.agents.find({ projectId: project._id }).sort({ lastSeenAt: -1 }).limit(50).toArray(),
      store.items.countDocuments({ projectId: project._id }),
    ]);

    // Whatever was touched most recently fills the rest of the page, minus the
    // rows already on it. Not "the finished ones", which reads better and asks
    // the database for something it has no index for: filtering on status and
    // sorting by date made it walk twenty one thousand documents to find
    // twenty five. This walks the twenty five it returns. A board with a full
    // page of live work never runs it at all.
    const shown = unfinished.map((item) => item._id);
    const items =
      unfinished.length >= ITEMS_SHOWN
        ? unfinished
        : [
            ...unfinished,
            ...(await store.items
              .find({ projectId: project._id, _id: { $nin: shown } }, { projection: ROW })
              .sort({ updatedAt: -1 })
              .limit(ITEMS_SHOWN - unfinished.length)
              .toArray()),
          ];

    // Urgent first, then oldest, which is what /operator has always done and is
    // now what the query asks for. This page used to show newest first:
    // somebody with time for one question answered the least important one, and
    // the two pages of the same product disagreed about what mattered.
    // Asked for by name rather than looked for in the list above. The list is
    // capped, and the confirmation is exactly what a person needs on the
    // question that was hardest to find: deriving it from a slice means the
    // page can decide, on a busy board, that the thing it just did did not
    // happen. Still read from the stored question and never from the URL, which
    // only names which one.
    const answeredId = one((request.query as { answered?: string }).answered);
    const justAnswered = answeredId
      ? ((await store.escalations.findOne({
          projectId: project._id,
          _id: answeredId,
          status: { $ne: 'open' },
        })) as EscalationDoc | null)
      : null;
    // Who is reading, when they happen to be signed in. Only the unclaimed
    // banner uses it, and only to offer the one thing a person without the
    // token can do: ask for the board.
    const session = project.claimedBy ? null : await readSession(store, request);
    const asked = session
      ? await store.handovers.findOne({ projectId: project._id, email: session.email })
      : null;

    const answerForm = (id: string, answer = '') => `
  <form method="post" action="/r/${escapeHtml(readToken)}/escalations/${escapeHtml(id)}">
    <label>Your answer
      <textarea name="answer" placeholder="The decision, in your words.">${escapeHtml(answer)}</textarea>
    </label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:8px;align-items:start">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>`;

    const escalationForm = (doc: EscalationDoc) => `
<div class="card">
  <p class="label">${escapeHtml(doc.agent)} &middot; ${when(doc.createdAt)}
    ${doc.priority === 'urgent' || doc.priority === 'high' ? chip(doc.priority, 'blocked') : ''}</p>
  <p style="font-size:17px"><b>${escapeHtml(doc.question)}</b></p>
  ${doc.context ? `<p style="color:var(--ink-2);white-space:pre-wrap">${escapeHtml(doc.context)}</p>` : ''}
  ${
    // The card this question is about, open, one click away. The slug was
    // already in the question's context as text, which meant retyping it into
    // the board's search box to see what the agent was looking at.
    doc.itemSlug
      ? `<p class="mono" style="font-size:12.5px"><a href="/r/${escapeHtml(readToken)}/board?card=${encodeURIComponent(
          doc.itemSlug,
        )}">${escapeHtml(doc.itemSlug)}</a></p>`
      : ''
  }
  ${answerForm(doc._id)}
</div>`;

    const itemRow = (item: ItemDoc) => {
      const last = item.timeline?.[item.timeline.length - 1];
      return `<tr>
  <td class="mono" data-label="Slug">${escapeHtml(item.slug)}</td>
  <td data-label="Title and last note">${escapeHtml(item.title || '(no title)')}${
        last ? `<br><span class="mono" style="color:var(--muted)">${escapeHtml(last.by)}: ${escapeHtml(last.message.slice(0, 90))}</span>` : ''
      }</td>
  <td data-label="State">${chip(item.status, item.status)}${item.stale ? ` ${chip('stale', 'stale')}` : ''}${
        item.claim ? ` ${chip(item.claim.agent, 'claim')}` : ''
      }</td>
  <td class="mono" data-label="Updated">${when(item.updatedAt)}</td>
</tr>`;
    };

    const body = `
<h1>${escapeHtml(project.name)}</h1>
${project.description ? `<p class="lead">${escapeHtml(project.description)}</p>` : ''}
<p class="mono" style="color:var(--muted)">${escapeHtml(project._id)} &middot;
  <a href="/r/${escapeHtml(readToken)}/board">open the board</a></p>
${
      // Said from the stored question, never from the URL: the parameter only
      // names which one, and a link somebody crafted cannot put words here.
      justAnswered
        ? `<div class="notice">Answered. ${escapeHtml(
            justAnswered.agent,
          )} picks it up on its next iteration, and this page will say when it did.</div>`
        : ''
    }
<p>${count(itemsHeld, 'item')}, ${count(project.counts.agents, 'agent')}, ${count(
      project.counts.escalations,
      'question',
    )} waiting for you.${project.expiresAt ? ` This project is unclaimed and will be deleted ${when(project.expiresAt)}.` : ''}</p>

${
      // Unclaimed, and the person reading this is usually the one who should
      // own it and the one who does not have the token. So the first thing
      // offered is the thing they can actually do: ask. The agents answer with
      // an offer, which is the existing /share path, and ownership still only
      // ever moves because the project moved it.
      project.expiresAt
        ? `<div class="notice warn"><b>Unclaimed.</b> Nobody owns this board yet, so it is on a
timer and on the small limits. Claiming it stops the timer, raises the caps and puts it in one
page with everything else you own.
${
  asked
    ? `<p style="margin:12px 0 0"><b>You asked for it ${when(asked.createdAt)}.</b> The agents see
that on their next iteration and hand it over by offering it to your address; the offer then
appears in <a href="/operator">your projects</a>, where one click accepts it.</p>`
    : session
      ? `<form method="post" action="/r/${escapeHtml(readToken)}/handover" style="margin-top:12px">
  ${csrfField(session)}
  <label>Anything the agents should know
    <input name="note" maxlength="200" placeholder="I am the operator for this fleet.">
  </label>
  <button type="submit">Ask the agents to hand this over</button>
</form>
<p class="why" style="margin:8px 0 0">Asks as ${escapeHtml(session.email)}. It does not take the
project: the agents grant it, which is why a link that gets forwarded cannot cost somebody their
board.</p>`
      : `<p style="margin:12px 0 0"><a href="/operator"><b>Sign in</b></a> and you can ask the
agents to hand this board over. No account and no password: a six digit code proves the address is
yours.</p>`
}
<details style="margin-top:12px"><summary class="why">I have the project token</summary>
<form class="row" method="post" action="/r/${escapeHtml(readToken)}/claim" style="margin-top:10px">
  <label>Email<input type="email" name="email" required placeholder="you@example.com"></label>
  <label>Project token<input type="password" name="token" required placeholder="mk_..."></label>
  <button type="submit">Send code</button>
</form>
<p class="why" style="margin:8px 0 0">Or the agent does it itself with
<code>POST /v1/${escapeHtml(project._id)}/claim</code>.</p>
</details></div>`
        : // What this address is, said where somebody is looking at it. The mail
          // that sends people here says the link is a password; the page they
          // land on said nothing, and the first person to arrive on a phone read
          // "answer these questions without signing in" as a hole in the
          // product rather than as the feature it is. A share sheet is one tap
          // away on that screen.
          `<p class="why">Owned by ${escapeHtml(redactAddress(project.claimedBy ?? ''))}${
            project.claimedAt ? ` since ${when(project.claimedAt)}` : ''
          }. ${
            // One sentence, and this is a judgement rather than brevity for
            // its own sake: on a phone the longer version pushed the question
            // somebody came here to answer below the fold. The reasoning
            // belongs in the mail, which has room for it; the page needs the
            // fact. Each power named here was added to the link later than the
            // sentence was written, which is exactly how a warning ends up a
            // version behind what it warns about.
            (project.visibility ?? 'link') === 'owner'
              ? 'Private: this page opens only for its owner, signed in.'
              : `Open by link: anybody who has this address ${READ_LINK_GRANTS}, without
signing in. <a href="/operator">Your projects</a> has the switch that closes it.`
          }</p>`
    }

${
      // A project that has never been written to looks broken rather than new,
      // and this is the first page a person sees, often before the agent has
      // written anything at all.
      items.length === 0 && agents.length === 0
        ? `<div class="notice">Nothing here yet. This page fills in when an agent registers and
writes its first item. Point it at <a href="/skill.md">skill.md</a> with the project token and it
will do the rest.</div>`
        : ''
    }

<h2>Waiting for you</h2>
${open.length === 0 ? '<p class="empty">Nothing. The agents are unblocked.</p>' : ''}
${
      // Two hundred questions fit in a free project and fifty are drawn here,
      // so the line above can honestly say more than this list shows. Saying
      // which fifty matters more than the number: they are the ones the agents
      // are most stuck behind.
      project.counts.escalations > open.length
        ? `<p class="why">Showing the ${open.length} most urgent of ${project.counts.escalations}.
Answering these frees the agents behind them first.</p>`
        : ''
    }
${open.map((doc) => escalationForm(doc as EscalationDoc)).join('')}

<h2>Items</h2>
${
      // The board says "and N more" when a column is cut, and this table said
      // nothing at all: past two hundred items it simply stopped, and a page
      // that quietly drops work is worse than a page that admits it cannot show
      // everything.
      itemsHeld > items.length
        ? `<p class="why">Showing ${items.length} of ${itemsHeld}. <a href="/r/${escapeHtml(
            readToken,
          )}/board">The board</a> has search and filters for the rest.</p>`
        : ''
    }
<div class="scroll cards"><table class="cards">
<thead><tr><th scope="col">Slug</th><th scope="col">Title and last note</th><th scope="col">State</th><th scope="col">Updated</th></tr></thead>
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
<div class="scroll cards"><table class="cards">
<thead><tr><th scope="col">Handle</th><th scope="col">What it is for</th><th scope="col">Scope</th><th scope="col">Last seen</th></tr></thead>
<tbody>
${
      agents.length === 0
        ? '<tr><td colspan="4" class="empty">Nobody has registered yet.</td></tr>'
        : agents
            .map(
              (agent) =>
                `<tr><td class="mono" data-label="Handle"><a href="/r/${escapeHtml(
                  readToken,
                )}/board?agent=${encodeURIComponent(
                  agent.handle,
                )}">${avatar(agent.handle)} ${escapeHtml(agent.handle)}</a></td><td data-label="What it is for">${
                  agent.description === ''
                    ? '<span class="empty">said nothing</span>'
                    : escapeHtml(agent.description)
                }</td><td class="mono" data-label="Scope">${escapeHtml(
                  agent.scope.join(', ') || '(everything)',
                )}</td><td class="mono" data-label="Last seen">${when(agent.lastSeenAt)}</td></tr>`,
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
                `<li><span class="when">${when(doc.withdrawnAt ?? doc.answeredAt)}</span><span class="who">${escapeHtml(
                  doc.withdrawnAt ? 'withdrawn' : doc.status,
                )}</span><span>${escapeHtml(doc.question)}${
                  // A withdrawal wears `wont_do` in the data, because that is
                  // what it means to anything reading it later. Here it must
                  // not: this page is where a person finds out whether they
                  // dropped a question or an agent took it back, and one word
                  // is the whole difference.
                  doc.withdrawnAt
                    ? `<br><span style="color:var(--ink-2)">${who(doc.withdrawnBy ?? 'an agent')} took it back${doc.withdrawnReason ? `: ${escapeHtml(doc.withdrawnReason)}` : ''}</span>`
                    : doc.answer ? `<br><span style="color:var(--ink-2)">${escapeHtml(doc.answer)}</span>` : ''
                }${
                  // Whether the answer landed. Answering into silence is the
                  // fastest way to stop answering at all.
                  doc.acknowledgedAt
                    ? `<br><span class="why">${who(doc.acknowledgedBy ?? 'an agent')} acted ${when(doc.acknowledgedAt)}${doc.acknowledgedNote ? `: ${escapeHtml(doc.acknowledgedNote)}` : ''}</span>`
                    : '<br><span class="why">not picked up yet</span>'
                }${
                  // An answer used to be final from the browser: four buttons
                  // that look alike, one click, no way back. Answering the
                  // wrong one is an ordinary human mistake and should cost a
                  // correction, not a support request.
                  `<details style="margin-top:6px"><summary class="why">change this answer</summary>${answerForm(
                    doc._id,
                    doc.answer ?? '',
                  )}</details>`
                }</span></li>`,
            )
            .join('')}</ul>`
    }
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(page(request, { title: `${project.name} on Muster`, nav: true }, body));
  });

  app.get('/r/:readToken/board', { schema: { hide: true } }, async (request, reply) => {
    const { readToken } = request.params as { readToken: string };
    // A form sends every field it has, so narrowing by one leaves the other
    // three in the URL as `owner=&label=&q=`. That URL is what somebody copies
    // to somebody else, so the empties are dropped once and the page is drawn
    // for the address that stays in the bar. Before the counting and before
    // the ceiling: this bounce is the same reader on the same page, and
    // charging them twice for one filter is a board that answers 429 to
    // somebody who pressed Enter once.
    const [asked, sent] = request.url.split('?');
    const raw = new URLSearchParams(sent ?? '');
    if ([...raw.entries()].some(([, value]) => value === '')) {
      const kept = new URLSearchParams();
      for (const [name, value] of raw.entries()) if (value !== '') kept.append(name, value);
      const canonical = kept.toString();
      // Rebuilt from the one path segment this route matched, taken raw.
      //
      // Not from the decoded token, because decode and encode is not a round
      // trip: `%2e%2e` comes back as `..`, which a client resolves away to a
      // path this service never named. And not from the request target either:
      // a request line may carry an absolute form, `GET http://elsewhere/...`,
      // which Fastify routes on its path while leaving the authority in
      // `request.url`, and echoing that into a Location is an open redirect.
      // One segment, split on the separator it cannot contain, between two
      // pieces this file wrote.
      const segment = asked!.split('/')[asked!.startsWith('/') ? 2 : 4] ?? '';
      return reply.redirect(`/r/${segment}/board${canonical === '' ? '' : `?${canonical}`}`, 303);
    }

    if (!limitSeeking(request, reply)) return reply;
    const project = await store.projects.findOne({ readToken });
    if (!project) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject(request));
    }
    if (!(await readableBy(store, request, project))) {
      return reply.code(404).type('text/html; charset=utf-8').send(noSuchProject(request));
    }
    if (!limitReads(request, reply)) return reply;
    // Counted once the page is actually going to be drawn. A stale bookmark and
    // a token probe both end above this line, and neither is somebody reading.
    //
    // Nor is the page reloading itself. The refresh below names an address
    // carrying `refreshed`, so the beat it makes is recognisable and does not
    // count: measured on production, a single board left open overnight was
    // sixty views an hour, all of them read as strangers arriving, and the
    // report divides hand-moved cards by that number to decide whether anybody
    // moves cards at all.
    if ((request.query as { refreshed?: string }).refreshed === undefined) {
      recordView(store, 'board', request, ourHost);
    }
    void maybeExpireClaims(store, project).catch(() => undefined);
    const query = request.query as {
      moved?: string;
      landed?: string;
      done?: string;
      what?: string;
      owner?: string;
      agent?: string;
      label?: string;
      q?: string;
      answered?: string;
      merged?: string;
      card?: string;
      new?: string;
    };
    // Which sheet is open, which this page has to know rather than guess: a
    // fragment never reaches a server, and a board that reloads itself has to
    // stop doing that while somebody is typing into one.
    const openCard = one(query.card)?.slice(0, 200) ?? '';
    const openNew = one(query.new) === '1';
    const narrowing = {
      ...(query.owner ? { owner: query.owner.slice(0, 48) } : {}),
      ...(query.agent ? { agent: query.agent.slice(0, 48) } : {}),
      ...(query.label ? { label: query.label.slice(0, 48) } : {}),
    };
    // A search that ran out of its budget is refused everywhere else, because
    // an empty page would claim there is nothing to find. A person is owed
    // more than a refusal: they get the board they would have had without the
    // search, and a line saying that is what happened. Everything else they
    // narrowed by is still in force, which is also the cheapest way out of it.
    let searchStopped: string | undefined;
    const [view, facets, waiting, waitingOn] = await Promise.all([
      loadBoard(store, project, {
        ...narrowing,
        // Raw, because the cut belongs to the search itself: slicing here as
        // well meant this door trimmed after cutting and the others before it.
        ...(query.q ? { q: query.q } : {}),
      }).catch((error: unknown) => {
        if (!(error instanceof ServiceError) || error.code !== 'search_too_slow') throw error;
        searchStopped =
          'That search was reading for longer than this board allows, so it was stopped. This is the board without it. Try another word beside it, or narrow by owner, agent or label first.';
        return loadBoard(store, project, narrowing);
      }),
      boardFacets(store, project),
      // The only work on this board that no agent will ever do. It was
      // reachable from here only through a link labelled "questions and
      // timeline", in muted monospace, whatever the queue held.
      store.escalations.countDocuments({ projectId: project._id, status: 'open' }),
      // The open questions that name a card, so the card can carry them. Capped
      // at the plan's own ceiling for open questions on the free tier, which is
      // far more than a board shows at once; a project past it has a queue
      // problem the board is not going to fix.
      store.escalations
        .find(
          { projectId: project._id, status: 'open', itemSlug: { $ne: null } },
          { projection: { itemSlug: 1, agent: 1, question: 1, context: 1 }, limit: 200 },
        )
        .toArray(),
    ]);
    // Every open question a card carries, in the order they were asked. Two
    // agents waiting on one item is ordinary, and a map of one per slug would
    // show whichever was read last and hide the rest until it was answered.
    const questions = new Map<string, BoardQuestion[]>();
    for (const doc of waitingOn) {
      if (typeof doc.itemSlug !== 'string' || doc.itemSlug === '') continue;
      const asked = questions.get(doc.itemSlug) ?? [];
      asked.push({
        id: doc._id,
        agent: doc.agent,
        question: doc.question,
        context: doc.context ?? '',
      });
      questions.set(doc.itemSlug, asked);
    }
    // The card an address names, wherever it has got to. A column keeps fifty
    // items and draws fifteen of them, and a link sent last week outlives both:
    // resolving the sheet against what the board happens to be holding is a
    // permalink that quietly stops opening anything.
    const openItem =
      openCard === ''
        ? null
        : (view.rows
            .flatMap((row) => row.columns.flatMap((cell) => cell.items))
            .find((item) => item.slug === openCard) ??
          ((await store.items.findOne(
            { projectId: project._id, slug: openCard },
            { projection: { timeline: 0 } },
          )) as ItemDoc | null));
    // A sheet the page did not draw holds nothing, so it does not hold the
    // refresh either: `?card=` naming a card this project never had is an
    // ordinary board that would otherwise quietly stop keeping itself true.
    const sheetOpen = openNew || openItem !== null;
    // And it says so. The lookup above falls back to the whole project, so a
    // card that is merely off the board, finished months ago or dropped, still
    // opens; nothing left here means nothing by that name exists. Answering
    // with the plain board was the same silence the API doors were taught out
    // of this morning, one door over: a link somebody followed did not do what
    // it said, and the page let them believe it had. The board still draws,
    // because a person who followed a stale link still wants the board.
    const cardMissing =
      openCard !== '' && openItem === null
        ? `This project has no card called "${openCard}", so this is the board without it. The link may have a typo in it, or it may point at another project's board.`
        : undefined;
    const agents = await agentDescriptions(store, project._id, view, openItem);

    // A question can be answered from a card now, and an answer that reloads
    // the page silently is how somebody answers the same thing twice. Read from
    // the stored question, never from the URL, which only names which one.
    const answeredHere = query.answered
      ? ((await store.escalations.findOne({
          projectId: project._id,
          _id: query.answered.slice(0, 64),
          status: { $ne: 'open' },
        })) as EscalationDoc | null)
      : null;

    // A move redirects back here saying what it did. The message is built from
    // the board's own columns rather than carried in the URL, so a crafted link
    // cannot put words on somebody else's page.
    const landedIn = view.config.columns.find((column) => column.key === query.landed);
    // The item as this page has it, found by the slug the redirect named. Using
    // the stored slug rather than the parameter keeps every word below server
    // written, and it is also how the page can say what the move did to the
    // card rather than only where it went.
    const touched = query.moved || query.done
      ? view.rows
          .flatMap((row) => row.columns.flatMap((cell) => cell.items))
          .find((item) => item.slug === (query.moved ?? query.done))
      : undefined;
    const heldUntil =
      touched?.claim && new Date(touched.claim.expiresAt) > new Date()
        ? touched.claim.expiresAt
        : null;
    const movedNotice = query.moved
      ? landedIn
        ? `"${touched?.slug ?? query.moved.slice(0, 80)}" is now in ${landedIn.title}.${
            // Moving a card into a claimed column takes it out on a lease. The
            // card comes back on its own an hour later, and somebody who was
            // never told that returns to a board that changed behind their
            // back.
            // Plain words, not the `<time>` element: this sentence is escaped
            // as a whole before it reaches the page, on purpose, so that no
            // crafted link can put markup on somebody else's board.
            heldUntil
              ? ` You are holding it, and it goes back to where it was ${ago(heldUntil)} unless something renews that.`
              : ''
          }`
        : `"${touched?.slug ?? query.moved.slice(0, 80)}" matches no column now. Check the layout below.`
      : undefined;
    // Assign and tag redirect the same way a move does. They used to redirect
    // silently, so the only evidence was a chip on a card the person then had
    // to find again by eye.
    // Plain text, like the notice above it: renderBoard escapes the whole
    // string, so escaping here as well printed an owner called O'Brien as
    // "O&#39;Brien". The rule for this pair of lines is that they are words,
    // and the renderer is the only thing that turns words into HTML.
    const doneNotice =
      query.done && touched
        ? query.what === 'label'
          ? `"${touched.slug}" is now tagged ${
              touched.labels.length > 0 ? touched.labels.join(', ') : 'nothing'
            }.`
          : query.what === 'unchanged'
            ? `Nothing was written to "${touched.slug}": it already said that.`
            : query.what === 'edit'
            ? `"${touched.slug}" now reads as you wrote it, and the timeline says who changed it.`
            : query.what === 'priority'
            ? `"${touched.slug}" is urgency ${touched.priority > 0 ? '+' : ''}${touched.priority}. Every queue here sorts by it, so this is what an agent is offered next.`
            : query.what === 'new'
            ? `"${touched.slug}" is on the board. Every agent reading this project sees it now.`
            : query.what === 'note'
            ? `Your note is on "${touched.slug}", where every agent that reads it will see it.`
            : query.what === 'waiting_refused'
            ? `Nothing was written to "${touched.slug}": one of the names you typed is not a slug. It is still waiting on ${(touched.blockedBy ?? []).length > 0 ? (touched.blockedBy ?? []).join(', ') : 'nothing'}.`
            : query.what === 'waiting_itself'
            ? `Nothing was written to "${touched.slug}": a card cannot wait on itself.`
            : query.what === 'waiting_too_many'
            ? `Nothing was written to "${touched.slug}": a card waits on at most ${MAX_BLOCKERS} others, and more than that is a plan rather than a dependency. It belongs in the description.`
            : query.what === 'waiting'
            ? (touched.blockedBy ?? []).length > 0
              ? `"${touched.slug}" is waiting on ${(touched.blockedBy ?? []).join(', ')}. No agent will be offered it, and a claim on it is refused, until those are done or dropped.`
              : `"${touched.slug}" is not waiting on anything any more, so it is back in what agents are offered.`
            : query.what === 'nothing'
              ? `Nothing was written to "${touched.slug}": the note was empty.`
              : `"${touched.slug}" is ${touched.owner ? `owned by ${touched.owner}` : 'unassigned'}.`
        : undefined;
    // The URL names which merge to confirm; the board decides whether it
    // happened. A parameter carrying the sentence itself is a link somebody can
    // send that puts words on this page, and a count nothing stored can be any
    // number they like: the alias on the surviving agent is the record, so that
    // is what is read.
    const mergedNotice = await (async () => {
      const said = one(query.merged);
      if (!said) return undefined;
      const [from, to] = said.split('>');
      if (!from || !to || !isValidHandle(from) || !isValidHandle(to)) return undefined;
      const survivor = await store.agents.findOne({
        projectId: project._id,
        handle: to,
        aliases: from,
      });
      if (!survivor) return undefined;
      return `"${from}" is now "${to}" here. Everything it wrote last is filed under the new name, and the timelines still say what they said.`;
    })();

    const notice = mergedNotice ?? (answeredHere
      ? `Answered. ${answeredHere.agent} picks it up on its next iteration, and the card will say when it did.`
      : (movedNotice ?? doneNotice));


    const boardUrl = `/r/${escapeHtml(readToken)}/board`;
    const body = `
<h1>${escapeHtml(project.name)}</h1>
${project.description ? `<p class="lead">${escapeHtml(project.description)}</p>` : ''}
<p class="mono" style="color:var(--muted)">${escapeHtml(project._id)} &middot;
  <a href="/r/${escapeHtml(readToken)}">${
    waiting > 0
      ? `<b>${waiting} question${waiting === 1 ? '' : 's'} waiting for you</b>`
      : 'questions and timeline'
  }</a></p>

${renderNewItem(boardUrl, project.rules.requireBodyAfterHours ?? null, view.filter, openNew)}
${renderBoard(view, {
  boardUrl,
  openItem,
  moveAction: `${boardUrl}/move`,
  questions,
  answerAction: `/r/${escapeHtml(readToken)}`,
  filters: renderBoardFilters(view, facets, boardUrl),
  timelines: await recentTimelines(store, project._id, view, openItem),
  agents,
  facets,
  // One query, and the same one the offer and the claim use, so the chip on
  // the card cannot disagree with what an agent asking for work is told.
  waiting: await waitingBlockers(store, project._id),
  projectId: project._id,
  ...(notice ? { notice } : {}),
  ...(searchStopped ? { searchStopped } : {}),
  ...(cardMissing ? { cardMissing } : {}),
})}

${
      project.sweptAt
        ? `<p class="mono" style="color:var(--muted);margin-top:18px">Hygiene last looked
  ${when(project.sweptAt)}: expired claims released, stale work flagged, absent items closed.</p>`
        : ''
    }

${renderBoardSettings(project, view, `/r/${escapeHtml(readToken)}/board`, boardWarnings(view.config), facets)}
`;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(request, {
            title: `${project.name} board`,
            description: project.description,
            wide: true,
            board: true,
            // Every minute, except while a sheet is open. A reload throws away
            // whatever is half typed in it, and the note somebody was writing
            // is the one thing on this page that nothing else can recover.
            ...(sheetOpen
              ? {}
              : { refreshSeconds: BOARD_REFRESH_SECONDS, refreshTo: refreshUrl(readToken, request.url) }),
          },
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
  /**
   * A cross site form post, refused.
   *
   * These routes are authorised by the token in the path, so for an ordinary
   * project CSRF adds nothing: whoever can forge the request already has the
   * link. For a project narrowed to its owner it is not nothing, because the
   * link alone no longer opens it and the browser's session cookie does: an
   * attacker who learned the read token could otherwise make the owner's own
   * browser move cards.
   *
   * `Sec-Fetch-Site` is asked first because it is the header that survives our
   * own policy. Origin does not: a page served with `Referrer-Policy:
   * no-referrer` posts with `Origin: null`, which is how this check spent a
   * night refusing every form on our own capability pages while the operator
   * read the refusal as the product being broken.
   *
   * An absent signal is allowed on purpose. Every browser sends both headers on
   * a form post; curl sends neither, and refusing those would break the agents.
   */
  // Compared as parsed origins, not as strings. A deployment whose BASE_URL is
  // spelled `https://Example.com:443` is the same site as the `https://example.com`
  // a browser puts in the header, and a string comparison would answer 403 to
  // every form on it.
  const ourOrigin = originOf(config.baseUrl);

  const sameOrigin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const verdict = fromOurPage(request, ourOrigin);
    if (verdict.ok) return true;
    // Counted, because this refusal is the one that cannot be seen from
    // outside: a browser gets a page, the agents never hit it, and the number
    // stays at zero until either somebody probes us or we break our own forms.
    // The reason is one of three fixed words; the origin itself is caller
    // supplied and never stored.
    record(store, 'refused', { door: 'browser', detail: verdict.reason });
    void reply
      .code(403)
      .type('text/html; charset=utf-8')
      .send(
        page(request, { title: 'Not from this page' },
          `<h1>That form did not come from here</h1>
           <p>The request arrived from ${escapeHtml(verdict.came)}, which is not this service.
           Nothing was changed. Open the board again and retry.</p>`,
        ),
      );
    return false;
  };

  const limitWrites = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!sameOrigin(request, reply)) return false;
    const { readToken } = request.params as { readToken: string };
    const verdict = limiter.check(`rl:${readToken}`, config.rateLimits.write);
    if (verdict.ok) return true;
    void reply
      .code(429)
      .header('retry-after', String(verdict.retryAfterSeconds))
      .type('text/html; charset=utf-8')
      .send(
        page(request, { title: 'Slow down' },
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
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board`, 303);
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
      actor: OPERATOR_ACTOR,
      note: owner === '' ? 'unassigned' : `assigned to ${owner}`,
      mustExist: true,
    });
    const params = new URLSearchParams({
      done: form.slug,
      what: 'owner',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  /**
   * What a card is waiting on, from the page.
   *
   * The field is written by agents, and until this it could only be written by
   * agents: a fleet stuck behind a slug somebody typed wrong had no way out
   * that did not involve a person finding a token and a terminal. The whole
   * premise of this product is that the human half works from the page, and
   * "unstick my board" is the most human half there is.
   */
  app.post('/r/:readToken/board/waiting', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { slug?: string; waiting?: string } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug) throw new ServiceError(400, 'bad_request', 'Which item?');

    // Commas, spaces or newlines: a person typing a list should not have to
    // find out which one this field wanted.
    // Everything they typed, and nothing quietly dropped: the service refuses a
    // list that is too long, and cutting it here would store something other
    // than what the person submitted and then tell them it worked.
    const waiting = (one(form.waiting) ?? '')
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    // The refusals this write can produce are all about what was typed into
    // one field, and a person who typed it is looking at this page rather than
    // at a JSON body. Answered on the board, in the same place every other
    // confirmation appears.
    let what = 'waiting';
    try {
      await upsertItem(store, project, {
        slug: form.slug,
        blockedBy: waiting,
        actor: OPERATOR_ACTOR,
        note:
          waiting.length === 0
            ? 'not waiting on anything any more'
            : `waiting on ${waiting.join(', ')}`,
        mustExist: true,
      });
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'bad_blocked_by') throw error;
      // Which of the three refusals it was. The service carries the reason
      // beside the code precisely so the page can say the true one: telling
      // somebody who typed the card's own slug that their name is not a slug
      // sends them looking for a spelling mistake that is not there.
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      what =
        reason === 'itself'
          ? 'waiting_itself'
          : reason === 'too_many'
            ? 'waiting_too_many'
            : 'waiting_refused';
    }
    const params = new URLSearchParams({
      done: form.slug,
      what,
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
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
        OPERATOR_ACTOR,
        add !== '' ? `tagged ${add}` : `untagged ${remove}`,
      );
    }
    const params = new URLSearchParams({
      done: form.slug,
      what: 'label',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  /**
   * A person writing into the timeline the agents read.
   *
   * Until this existed the board let somebody move a card, assign it and tag it,
   * and gave them nowhere to say why. Everything a person knew that the agents
   * did not had to reach them through some other channel, which is the failure
   * this product exists to fix, reproduced inside it.
   *
   * Under `operator`, like every other write through this link, so an agent
   * reading the item can tell a human's sentence from its own.
   */
  /**
   * A person filing a card.
   *
   * The slug comes from the title, because a slug is an idempotency key an
   * agent needs and jargon a person should not have to meet. Which means this
   * route, unlike every other write here, must not upsert: two people filing
   * "check the bridge" a week apart mean two pieces of work, and landing the
   * second on top of the first would rewrite a card somebody else is holding.
   * So it looks first and walks the name along until it is free.
   */
  /**
   * Two spellings of one agent, consolidated by the person looking at both.
   *
   * The same call the API offers, from the page that shows the problem. It
   * rewrites whose work an item is, which is why it lives under the fold with
   * the layout editor rather than beside the filters.
   */
  app.post('/r/:readToken/board/agent-rename', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { from?: string; to?: string } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    const moved = await renameAgent(store, project, one(form.from) ?? '', one(form.to) ?? '');
    const params = new URLSearchParams({
      merged: `${moved.from}>${moved.to}`,
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  app.post('/r/:readToken/board/new', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as {
      title?: string;
      body?: string;
      priority?: string;
    } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }

    const title = (one(form.title) ?? '').trim().slice(0, 200);
    if (title === '') throw new ServiceError(400, 'bad_request', 'An item needs a title.');
    const body = (one(form.body) ?? '').trim().slice(0, 4000);
    // Absent or nonsense reads as ordinary work, which is what an agent filing
    // without a priority gets, so the two doors agree on the same silence.
    const asked = wholeNumber(one(form.priority));
    const priority = asked === null ? 0 : Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, asked));

    // Two steps, and each one answers a different question. The lookup handles
    // the ordinary case, a name already in use, and picks the next one along.
    // `insertOnly` handles the race the lookup cannot see, two people filing
    // the same words in the same instant: the write itself decides who created
    // the item, and whoever did not gets another name rather than their words
    // landing on the other's card.
    const base = normalizeSlug(title) || 'item';
    let slug = base;
    let filed = false;
    for (let attempt = 1; attempt <= 6 && !filed; attempt += 1) {
      const taken = await store.items.findOne(
        { projectId: project._id, slug },
        { projection: { _id: 1 } },
      );
      if (!taken) {
        const written = await upsertItem(store, project, {
          slug,
          title,
          body,
          priority,
          actor: OPERATOR_ACTOR,
          insertOnly: true,
        });
        filed = written.created;
      }
      if (!filed) {
        // Numbered while the numbers are readable, then random, because a sixth
        // collision is not a person filing a sixth "check the bridge" and the
        // loop has to end on a name nobody can already hold.
        slug =
          attempt < 4
            ? `${base.slice(0, 90)}-${attempt + 1}`
            : `${base.slice(0, 86)}-${newId('x', 5).slice(2)}`;
      }
    }
    if (!filed) {
      throw new ServiceError(
        409,
        'slug_taken',
        'That title could not be given a name of its own. Try a different one.',
      );
    }
    const params = new URLSearchParams({ done: slug, what: 'new', ...keptParams(form) });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  /**
   * How urgent, from the board.
   *
   * Filing existed and prioritising did not, which put a person's card behind
   * everything the agents had filed at +5: `/next` offers by priority, so work
   * a person asked for first arrived last. The scale is the item's own, and the
   * page offers four points on it rather than the number, because a board is
   * read by somebody who should not have to learn the whole scale to say
   * "this one first".
   */
  app.post('/r/:readToken/board/priority', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { slug?: string; priority?: string } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug) throw new ServiceError(400, 'bad_request', 'Which item?');

    const priority = wholeNumber(one(form.priority));
    if (priority === null || priority < PRIORITY_MIN || priority > PRIORITY_MAX) {
      throw new ServiceError(400, 'bad_priority', `Priority is a whole number from ${PRIORITY_MIN} to ${PRIORITY_MAX}.`);
    }
    await upsertItem(store, project, {
      slug: form.slug,
      priority,
      actor: OPERATOR_ACTOR,
      note: `urgency set to ${priority > 0 ? '+' : ''}${priority}`,
      mustExist: true,
    });
    const params = new URLSearchParams({
      done: form.slug,
      what: 'priority',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  /**
   * Correcting the words on a card.
   *
   * The one write here that replaces rather than adds, which is why it is the
   * one folded shut on the page. A blank title would leave a card nobody can
   * read, so an empty field means "leave this as it is" rather than "make it
   * nothing": clearing a description on purpose is rare enough to be worth a
   * space, and losing a title to a stray select-all is not.
   */
  app.post('/r/:readToken/board/edit', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as {
      slug?: string;
      title?: string;
      body?: string;
      was_title?: string;
      was_body?: string;
    } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug) throw new ServiceError(400, 'bad_request', 'Which item?');

    // The domain's own ceilings, not the form's. An agent can write a longer
    // title and a much longer body than a page offers boxes for, and cutting
    // them here would mean correcting a title silently truncated a description
    // nobody was editing.
    const title = (one(form.title) ?? '').trim().slice(0, 300);
    const body = (one(form.body) ?? '').slice(0, 20_000);
    const wasTitle = one(form.was_title) ?? '';
    const wasBody = one(form.was_body) ?? '';

    // Only what this person actually changed, guarded on what they were looking
    // at. Two people share this card by construction, and writing back a field
    // somebody never touched is how a form quietly undoes an agent's work
    // between the render and the submit. The guard travels with the write
    // rather than preceding it: a check before an update leaves room for
    // exactly the change it is trying not to lose.
    const changed: { title?: string; body?: string } = {};
    const expect: { title?: string; body?: string } = {};
    if (title !== '' && title !== wasTitle) {
      changed.title = title;
      expect.title = wasTitle;
    }
    if (body !== wasBody) {
      changed.body = body;
      expect.body = wasBody;
    }
    if (Object.keys(changed).length > 0) {
      await upsertItem(store, project, {
        slug: form.slug,
        ...changed,
        expect,
        actor: OPERATOR_ACTOR,
        note: `${Object.keys(changed).join(' and ')} edited from the board`,
        mustExist: true,
      });
    }
    const params = new URLSearchParams({
      done: form.slug,
      what: Object.keys(changed).length > 0 ? 'edit' : 'unchanged',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  app.post('/r/:readToken/board/note', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { slug?: string; message?: string } & KeptFilter;
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    if (!form.slug) throw new ServiceError(400, 'bad_request', 'Which item?');

    // Cut here, not only in the textarea: `maxlength` is a courtesy to a browser
    // and a suggestion to anybody posting straight at this route, and a timeline
    // is inside the item document, which has a ceiling of its own.
    const message = (one(form.message) ?? '').trim().slice(0, NOTE_MAX_CHARS);
    // An empty note is a slip of the hand, not an instruction to write nothing:
    // it goes back to the board having changed nothing rather than filing a
    // blank line into a timeline everybody reads.
    if (message !== '') {
      await appendNote(store, project, form.slug, OPERATOR_ACTOR, message);
    }
    const params = new URLSearchParams({
      done: form.slug,
      what: message === '' ? 'nothing' : 'note',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
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
      actor: OPERATOR_ACTOR,
    });
    record(store, 'move', { door: 'browser', detail: form.column.slice(0, 40), projectId: project._id });
    // Back to the board they were actually looking at. Somebody working through
    // one agent's queue should not be thrown to the whole board by moving a card.
    const params = new URLSearchParams({
      moved: result.item.slug,
      landed: result.landedIn ?? '',
      ...keptParams(form),
    });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  app.post('/r/:readToken/escalations/:id', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken, id } = request.params as { readToken: string; id: string };
    const form = (request.body ?? {}) as {
      status?: string;
      answer?: string;
      back?: string;
    } & KeptFilter;
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
    await answerEscalation(store, project._id, id, status, (form.answer ?? '').slice(0, 8000), 'browser');
    // Named in the redirect so the page can confirm it. Four buttons that look
    // alike and a silent reload is how somebody ends up answering twice.
    //
    // Back where it was answered from. A question can now be answered on the
    // card it is about, and landing somebody on a different page than the one
    // they were reading is how a board loses its place. One fixed alternative
    // rather than a URL from the form: a redirect target somebody can type is
    // a redirect target somebody else can send.
    if ((form.back ?? '') !== 'board') {
      return reply.redirect(`/r/${encodeURIComponent(readToken)}?answered=${encodeURIComponent(id)}`, 303);
    }
    // Back to the board as it was being read, narrowing included: answering a
    // question from a filtered board and landing on the unfiltered one is the
    // board losing somebody's place for them.
    const params = new URLSearchParams({ answered: id, ...keptParams(form) });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}/board?${params.toString()}`, 303);
  });

  /**
   * A person with the link asking the agents to hand the board over.
   *
   * The address comes from the signed in session, never from a field: a typed
   * address would have to be proved with another code, and the operator sign
   * in already proves exactly this. Which means a cookie is in play, so the
   * form carries the CSRF token like every other cookie-authenticated write
   * in this service.
   *
   * This never moves ownership. It records an ask; the project answers it with
   * `POST /share`, and that is still the only way `claimedBy` changes.
   */
  app.post('/r/:readToken/handover', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    const { readToken } = request.params as { readToken: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }
    const session = await readSession(store, request);
    if (!session) {
      return reply.type('text/html; charset=utf-8').send(
        page(request, { title: 'Sign in first' },
          `<h1>Sign in first</h1>
           <p>Asking for a board means saying which address should own it, and this one is not
           signed in. <a href="/operator">Sign in</a> with a six digit code and come back to this
           link.</p>`,
        ),
      );
    }
    // Every refusal on this route is a page, not JSON. The rest of `/r/` is
    // for somebody holding a capability link, who can read a status code; this
    // one is advertised to an ordinary person as a button, and the three ways
    // it says no are all ordinary: the agents offered it a minute ago, five
    // people are already waiting, or the tab has been open since last week.
    const explain = (error: unknown) => {
      const failure = error instanceof ServiceError ? error : null;
      return reply
        .code(failure?.statusCode ?? 500)
        .type('text/html; charset=utf-8')
        .send(
          page(request, { title: 'That did not go through' },
            `<h1>That did not go through</h1>
             <p>${escapeHtml(failure?.message ?? 'Something went wrong asking for this board.')}</p>
             <p><a href="/r/${escapeHtml(readToken)}">Back to the project</a></p>`,
          ),
        );
    };

    try {
      checkCsrf(session, request.body);
      const form = (request.body ?? {}) as { note?: string };
      await requestHandover(store, project, session.email, one(form.note));
    } catch (error) {
      return explain(error);
    }
    record(store, 'handover_request', { door: 'browser', projectId: project._id });
    return reply.redirect(`/r/${encodeURIComponent(readToken)}`, 303);
  });

  app.post('/r/:readToken/claim', { schema: { hide: true } }, async (request, reply) => {
    // The only write through a read link that was missing this. It costs a
    // loopback request to /v1/{project}/claim, so an unlimited one is a small
    // amplifier pointed at ourselves.
    if (!limitWrites(request, reply)) return reply;
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
    // token: whoever can write to the project decides who owns it, and an
    // admin token is what proves that.
    //
    // In process, not a request to our own public URL. That loopback was one
    // more thing to go wrong in production and, worse, made the route
    // untestable: the suite's base URL does not resolve, so the check this
    // page exists to enforce was never once exercised by a test.
    let ok = false;
    let floodedFor: number | null = null;
    try {
      const { key } = await authenticate(store, form.token ?? '');
      if (key.projectId === project._id && key.role === 'admin') {
        // The per project limit on claim emails, which the loopback used to
        // apply on our behalf: without it this form sends at the ordinary
        // write rate, and every send invalidates the pending code.
        //
        // Charged only once the token has proved itself. Charging it first let
        // anybody holding the read link spend the project's whole hourly
        // budget on five wrong tokens, which blocks the real claim from the
        // browser and from the API alike.
        const verdict = limiter.check(`claim:${project._id}`, config.rateLimits.claimEmail);
        if (!verdict.ok) floodedFor = verdict.retryAfterSeconds;
        else {
          const started = await startEmailClaim(store, project, form.email ?? '', config, mailer);
          ok = started.alreadyClaimedBy === null;
        }
      }
    } catch {
      // Every refusal reads the same to whoever is at the form: a wrong token,
      // a token for another project, a worker key and a bad address are all
      // "that did not work", because telling them apart is telling a stranger
      // which of their guesses was close.
      ok = false;
    }
    if (floodedFor !== null) {
      return reply
        .code(429)
        .header('retry-after', String(floodedFor))
        .type('text/html; charset=utf-8')
        .send(
          page(request, { title: 'Slow down' },
            `<h1>Too many codes for this project</h1>
             <p>Use the code that was already sent, or try again in ${floodedFor} seconds.</p>`,
          ),
        );
    }
    return reply.type('text/html; charset=utf-8').send(
      page(request, { title: ok ? 'Check your email' : 'Claim failed' },
        ok
          ? `<h1>Check your email</h1>
             <p>A six digit code is on its way to ${escapeHtml(form.email ?? '')}. It is good for
             15 minutes and works once.</p>
             <form method="post" action="/r/${escapeHtml(readToken)}/claim/verify">
               <input type="hidden" name="email" value="${escapeHtml(form.email ?? '')}">
               <label>Code
                 <input name="code" inputmode="numeric" autocomplete="one-time-code" required
                        pattern="[0-9]{6}" placeholder="123456">
               </label>
               <button type="submit">Claim this project</button>
             </form>
             <p><a href="/r/${escapeHtml(readToken)}">Back to the project</a>, or give the code to
             your agent and let it finish with
             <code>POST /v1/${escapeHtml(project._id)}/claim/verify</code>.</p>`
          : `<h1>Claim failed</h1><p>The token did not match this project, or the address was
             rejected. <a href="/r/${escapeHtml(readToken)}">Try again</a>.</p>`,
      ),
    );
  });

  /**
   * The second half of a claim, in a browser.
   *
   * It asks for no token, and does not need one: the first half already
   * demanded the project token to have the code sent at all, and the code
   * itself only reaches the mailbox it was addressed to. Requiring the token
   * again would only mean rendering it into a hidden field, which is how a
   * credential ends up in a page.
   *
   * Before this existed, the browser path ended at a curl command with a
   * placeholder in it. The person Muster is asking to take ownership of a board
   * is not always the person who has a terminal open.
   */
  app.post('/r/:readToken/claim/verify', { schema: { hide: true } }, async (request, reply) => {
    if (!limitWrites(request, reply)) return reply;
    // Plus the bucket built for typing a code into a form, the same one
    // /operator uses for its own code field: a second code box in one service
    // should count against the same limit as the first.
    //
    // Keyed by caller, not by the read link, which every visitor shares: a
    // bucket on the token would let one of them spend the whole allowance and
    // lock out the person the code was actually sent to. The real ceiling on
    // guessing is the five attempts a pending claim carries.
    const verdict = limiter.check(codeAttemptKey(clientIp(request)), config.rateLimits.verifyCode);
    if (!verdict.ok) {
      return reply
        .code(429)
        .header('retry-after', String(verdict.retryAfterSeconds))
        .type('text/html; charset=utf-8')
        .send(
          page(request, { title: 'Slow down' },
            `<h1>Too many tries</h1><p>Try again in ${verdict.retryAfterSeconds} seconds.</p>`,
          ),
        );
    }
    const { readToken } = request.params as { readToken: string };
    const form = (request.body ?? {}) as { email?: string; code?: string };
    const project = await store.projects.findOne({ readToken });
    if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
    if (!(await readableBy(store, request, project))) {
      throw new ServiceError(404, 'not_found', 'No such project.');
    }

    try {
      await verifyClaimCode(store, project, form.email ?? '', (form.code ?? '').trim(), config);
    } catch (error) {
      const message =
        error instanceof ServiceError
          ? error.message
          : 'Something went wrong finishing the claim.';
      return reply
        .code(error instanceof ServiceError ? error.statusCode : 500)
        .type('text/html; charset=utf-8')
        .send(
          page(request, { title: 'That code did not work' },
            `<h1>That code did not work</h1><p>${escapeHtml(message)}</p>
             <p><a href="/r/${escapeHtml(readToken)}">Back to the project</a> to start again.</p>`,
          ),
        );
    }
    record(store, 'claim', { door: 'browser', projectId: project._id });
    return reply.type('text/html; charset=utf-8').send(
      page(request, { title: 'Claimed' },
        `<h1>This project is yours</h1>
         <p>It no longer expires, the limits are raised, and it now appears in
         <a href="/operator">your projects</a> alongside anything else you own. Sign in there with
         this address whenever you want the whole queue in one page.</p>
         <p><a href="/r/${escapeHtml(readToken)}">Back to the project</a></p>`,
      ),
    );
  });
}
