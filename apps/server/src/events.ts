import type { Store } from './db.js';
import { newId } from './ids.js';

/**
 * What this service knows about how it is being used.
 *
 * Almost everything worth knowing is already in the data: how many projects
 * exist, how many were claimed, how much work was written and finished, how
 * fast questions get answered. What the collections cannot show is the top of
 * the funnel, because reading `skill.md` and deciding not to sign up leaves no
 * document behind, and neither does the difference between an agent arriving
 * over curl, over MCP or through OAuth.
 *
 * So: a small append-only log of moments, and nothing else. No address, no
 * token, no request body, no user agent string, no IP. The one identifier is a
 * project id, and only where the moment is about a project. It expires after
 * ninety days, which is long enough to see a trend and short enough that this
 * never becomes a second copy of the service's data.
 *
 * The page it feeds has no JavaScript and neither does anything else here, so
 * there is no snippet, no third party, and nothing for a visitor to block.
 */
export type EventKind =
  /** Somebody fetched one of the protocol files. The top of the funnel. */
  | 'discover'
  /** A person opened one of the pages. The half of the funnel agents cannot show. */
  | 'view'
  /** A project was created. */
  | 'signup'
  /** An agent registered itself in a project. */
  | 'register'
  /** The first item written to a project: the point where a signup became use. */
  | 'first_write'
  /** A person took ownership by confirming an email. */
  | 'claim'
  /** A person accepted a project an agent handed them. */
  | 'accept'
  /** A question was filed for a human. */
  | 'escalate'
  /** A human answered one. */
  | 'answer';

/** Which door it came through. */
export type EventDoor = 'http' | 'mcp' | 'oauth' | 'browser';

/**
 * The pages a view can be recorded for, and nothing else.
 *
 * A closed set rather than the request path, for one reason that outranks
 * tidiness: a read link and an operator link are credentials that live in the
 * path, so recording the URL would write working capabilities into a
 * collection built to hold no secrets at all. The two capability pages are
 * counted under a name that says which kind of page it was and nothing about
 * which project.
 */
export const VIEWABLE = [
  'landing',
  'docs',
  'docs/keys',
  'pricing',
  'signup',
  'operator',
  'project',
  'board',
] as const;

export type Viewable = (typeof VIEWABLE)[number];

/**
 * Crawlers, as far as a page counter needs to care.
 *
 * Not a security control and not exhaustive: a counter that includes every
 * indexing bot answers "how often are we crawled", which nobody asked. The
 * string is read and thrown away; no user agent is ever stored.
 */
const CRAWLER = /bot\b|bot\/|crawler|spider|slurp|feedfetcher|scrapy|curl\/|wget/i;

export function isCrawler(userAgent: string | undefined): boolean {
  return userAgent !== undefined && CRAWLER.test(userAgent);
}

export interface EventDoc {
  _id: string;
  at: Date;
  kind: EventKind;
  door: EventDoor;
  /** Which file, for `discover`. Never anything caller-supplied. */
  detail: string | null;
  projectId: string | null;
  expiresAt: Date;
}

const KEEP_DAYS = 90;

/** How many of the most recent answers the median is taken over. */
export const ANSWER_SAMPLE = 500;

/**
 * Writes in flight. Nothing on a request path waits for these, but two things
 * need to: a test that wants to assert what was recorded, and a shutdown that
 * would otherwise drop the last few on the floor.
 */
const inFlight = new Set<Promise<unknown>>();

/**
 * Waits for everything started so far, but not forever.
 *
 * Loops, because one of these writes can start another: the activation guard
 * reads the project, then records. Bounded, because shutdown awaits this and
 * the driver has no socket timeout, so a write the database accepted and never
 * finished would hold a dyno open until the platform killed it. Losing a
 * telemetry record is the cheapest thing in this system.
 */
export async function flushEvents(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let round = 0; round < 5 && inFlight.size > 0; round += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((resolve) => setTimeout(resolve, left).unref?.()),
    ]);
  }
}

/**
 * Records a moment. Never awaited on a request path, and never able to fail one:
 * telemetry that can break the thing it measures is worse than no telemetry.
 */
export function record(
  store: Store,
  kind: EventKind,
  options: { door: EventDoor; detail?: string; projectId?: string } = { door: 'http' },
): void {
  const now = new Date();
  const write = store.events
    .insertOne({
      _id: newId('e'),
      at: now,
      kind,
      door: options.door,
      detail: options.detail ?? null,
      projectId: options.projectId ?? null,
      expiresAt: new Date(now.getTime() + KEEP_DAYS * 86_400_000),
    })
    .catch(() => undefined)
    .finally(() => inFlight.delete(write));
  inFlight.add(write);
}

/**
 * Records that a person looked at a page.
 *
 * The one thing the collections cannot show: an agent's reads leave items
 * behind, a person reading the landing page and closing the tab leaves
 * nothing. Crawlers are dropped rather than counted, because "how often are we
 * indexed" is a different question from "how many people looked".
 */
export function recordView(store: Store, page: Viewable, userAgent: string | undefined): void {
  if (isCrawler(userAgent)) return;
  record(store, 'view', { door: 'browser', detail: page });
}

/**
 * Records the moment a project first received work, exactly once, ever.
 *
 * The obvious test, "were there no items before this one", is wrong twice over:
 * the counter holds *open* items, so a first item created as done leaves it at
 * zero and every later write looks like a first, and two concurrent creates
 * both read the same zero. A guarded write to the project is the only thing
 * that can answer "has this ever happened" once.
 */
export function recordFirstWrite(store: Store, projectId: string, door: EventDoor): void {
  const work = (async () => {
    const flagged = await store.projects.updateOne(
      { _id: projectId, firstWriteAt: { $exists: false } },
      { $set: { firstWriteAt: new Date() } },
    );
    if (flagged.modifiedCount === 1) record(store, 'first_write', { door, projectId });
  })()
    // Same rule as the rest of this file: measuring never breaks the request.
    .catch(() => undefined)
    .finally(() => inFlight.delete(work));
  inFlight.add(work);
}

export interface Insights {
  generatedAt: Date;
  /** Projects, and how far each got. */
  funnel: {
    discovered: number;
    signups: number;
    withAnAgent: number;
    withWork: number;
    claimed: number;
  };
  doors: Record<string, number>;
  /** Page views by page, people only. The half of the funnel agents cannot show. */
  pages: Record<string, number>;
  /** Views in the last seven days, so a trend is visible without a chart. */
  pagesLastWeek: number;
  /** What is on the boards right now, across every project. */
  live: {
    projects: number;
    claimedProjects: number;
    openItems: number;
    agents: number;
    openQuestions: number;
    staleItems: number;
  };
  /** How the service behaves rather than how much of it exists. */
  behaviour: {
    /** Signups that wrote at least one item. The number the product lives on. */
    activationRate: number;
    /** Signups a person took ownership of. */
    claimRate: number;
    /** Median hours to an answer, over the most recent ANSWER_SAMPLE answers. */
    medianAnswerHours: number | null;
    /** How many answers that median was taken over, so it can be read honestly. */
    answersSampled: number;
    /** Items closed by the hygiene engine rather than by anybody. */
    closedByHygiene: number;
  };
  busiestProjects: Array<{ project: string; name: string; items: number; agents: number }>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * The whole picture, in one read. Written to be run from a terminal against a
 * production connection string rather than served from a page: this is the
 * operator of the service looking at their own service, not a feature of it,
 * and adding a URL for it would mean adding a credential to protect it.
 */
export async function insights(store: Store): Promise<Insights> {
  const [
    discovered,
    signups,
    registered,
    firstWrites,
    claims,
    doorRows,
    pageRows,
    viewsLastWeek,
    projects,
    claimedProjects,
    openItems,
    agents,
    openQuestions,
    staleItems,
    answered,
    hygieneClosed,
    busiest,
  ] = await Promise.all([
    store.events.countDocuments({ kind: 'discover' }),
    store.events.countDocuments({ kind: 'signup' }),
    // Projects that got an agent, not agents that got registered. One project
    // with six loops is one project that reached this stage, and counting the
    // registrations would push a funnel stage above the signups above it.
    store.events
      .aggregate<{ n: number }>([
        { $match: { kind: 'register', projectId: { $ne: null } } },
        { $group: { _id: '$projectId' } },
        { $count: 'n' },
      ])
      .toArray(),
    store.events.countDocuments({ kind: 'first_write' }),
    store.events.countDocuments({ kind: 'claim' }),
    store.events
      .aggregate<{ _id: string; count: number }>([
        { $match: { kind: 'signup' } },
        { $group: { _id: '$door', count: { $sum: 1 } } },
      ])
      .toArray(),
    store.events
      .aggregate<{ _id: string; count: number }>([
        { $match: { kind: 'view' } },
        { $group: { _id: '$detail', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray(),
    store.events.countDocuments({
      kind: 'view',
      at: { $gte: new Date(Date.now() - 7 * 86_400_000) },
    }),
    store.projects.countDocuments({}),
    store.projects.countDocuments({ claimedBy: { $ne: null } }),
    store.items.countDocuments({ status: { $nin: ['done', 'dropped'] } }),
    store.agents.countDocuments({}),
    store.escalations.countDocuments({ status: 'open' }),
    store.items.countDocuments({ stale: true, status: { $nin: ['done', 'dropped'] } }),
    // Sorted before it is cut. An unsorted limit takes whatever the storage
    // engine hands back first, which past five hundred answers means a median
    // of an arbitrary old subset that silently stops moving.
    store.escalations
      .find({ answeredAt: { $ne: null } }, { projection: { createdAt: 1, answeredAt: 1 } })
      .sort({ answeredAt: -1 })
      .limit(ANSWER_SAMPLE)
      .toArray(),
    store.items.countDocuments({
      status: { $in: ['done', 'dropped'] },
      'timeline.by': 'hygiene',
    }),
    store.projects
      .find({}, { projection: { name: 1, counts: 1 } })
      .sort({ 'counts.items': -1 })
      .limit(5)
      .toArray(),
  ]);

  const answerHours = answered
    .map((doc) => (doc.answeredAt!.getTime() - doc.createdAt.getTime()) / 3_600_000)
    .filter((hours) => hours >= 0);

  return {
    generatedAt: new Date(),
    funnel: {
      discovered,
      signups,
      withAnAgent: registered[0]?.n ?? 0,
      withWork: firstWrites,
      claimed: claims,
    },
    doors: Object.fromEntries(doorRows.map((row) => [row._id, row.count])),
    pages: Object.fromEntries(pageRows.map((row) => [row._id, row.count])),
    pagesLastWeek: viewsLastWeek,
    live: {
      projects,
      claimedProjects,
      openItems,
      agents,
      openQuestions,
      staleItems,
    },
    behaviour: {
      activationRate: signups === 0 ? 0 : firstWrites / signups,
      claimRate: signups === 0 ? 0 : claims / signups,
      medianAnswerHours: median(answerHours),
      answersSampled: answerHours.length,
      closedByHygiene: hygieneClosed,
    },
    busiestProjects: busiest.map((project) => ({
      project: project._id,
      name: project.name,
      items: project.counts?.items ?? 0,
      agents: project.counts?.agents ?? 0,
    })),
  };
}
