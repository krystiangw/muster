#!/usr/bin/env -S npx tsx
/**
 * What this service does when the data stops being small.
 *
 * Every number in the repository so far was taken against a board with seventy
 * items on it. That says nothing about the queries: a collection scan and an
 * index look identical at that size, and the difference only appears on the day
 * somebody's fleet has been writing for a year.
 *
 * So this fills a real mongod with a year of a busy fleet, drives the paths a
 * person and an agent actually take, and prints wall clock alongside what the
 * planner did: how many documents it had to look at to return the ones it
 * returned. The second number is the one that predicts the future; the first is
 * the one that gets noticed.
 *
 *   npx tsx apps/server/tools/perf-audit.mts
 *   ITEMS=200000 npx tsx apps/server/tools/perf-audit.mts
 *
 * Nothing here touches a deployment. It starts its own database, fills it,
 * measures it and throws it away.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStore, ensureIndexes, type Store } from '../src/db.js';
import { newId, newToken, hashToken } from '../src/ids.js';
import {
  DEFAULT_BOARD,
  DEFAULT_RULES,
  type AgentDoc,
  type EscalationDoc,
  type EventDoc,
  type ItemDoc,
  type ProjectDoc,
} from '../src/types.js';

const ITEMS = Number(process.env.ITEMS ?? 50_000);
const PROJECTS = Number(process.env.PROJECTS ?? 200);
const ESCALATIONS = Number(process.env.ESCALATIONS ?? 5_000);
const AGENTS = Number(process.env.AGENTS ?? 200);
const EVENTS = Number(process.env.EVENTS ?? 200_000);

const AGENT_HANDLES = ['errors-loop', 'trades-loop', 'pm-loop', 'system-loop', 'scoring-loop'];
const LABELS = ['build', 'ops', 'security', 'docs', 'infra', 'product'];
const OWNERS = ['alex', 'sam', null, null];
const STATUSES: ItemDoc['status'][] = ['open', 'open', 'blocked', 'done', 'done', 'done', 'dropped'];

const started = Date.now();
const say = (line: string) => console.log(line);
// A deterministic shuffle, because a run that cannot be repeated is an anecdote.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!;

const mongo = await MongoMemoryServer.create();
const config = loadConfig({
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: 'perf',
  BASE_URL: 'http://127.0.0.1:4700',
  LOG_LEVEL: 'silent',
  LIMIT_WRITES_PER_MINUTE: '10000000',
  LIMIT_READS_PER_MINUTE: '10000000',
});
const store = await createStore(config.mongoUri, config.mongoDb);
await ensureIndexes(store);

const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

/** The fleet's own board: everything below is written into this one. */
const main: ProjectDoc = {
  _id: newId('p'),
  name: 'a year of a busy fleet',
  description: 'seeded by perf-audit',
  tier: 'free',
  limits: config.tiers.free,
  counts: { items: 0, agents: 0, escalations: 0 },
  // The rules a real project gets, not a subset: a rule left undefined reads as
  // "not null" and runs with a nonsense cutoff, which measures a query nobody
  // issues.
  rules: DEFAULT_RULES,
  board: DEFAULT_BOARD,
  readToken: newId('r', 16),
  claimedBy: 'operator@example.com',
  claimedAt: ago(365),
  createdAt: ago(365),
  expiresAt: null,
  firstWriteAt: ago(365),
} as ProjectDoc;
await store.projects.insertOne(main);

const adminToken = newToken();
await store.keys.insertOne({
  _id: newId('k'),
  projectId: main._id,
  hash: hashToken(adminToken),
  name: 'perf',
  role: 'admin',
  createdAt: now,
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
} as never);

const bulk = async <T>(name: string, total: number, make: (index: number) => T, into: { insertMany: (docs: T[], options: unknown) => Promise<unknown> }) => {
  const batch = 2_000;
  const at = Date.now();
  for (let start = 0; start < total; start += batch) {
    const docs = Array.from({ length: Math.min(batch, total - start) }, (_, offset) => make(start + offset));
    await into.insertMany(docs, { ordered: false });
  }
  say(`  ${name.padEnd(12)} ${String(total).padStart(7)} in ${((Date.now() - at) / 1000).toFixed(1)}s`);
};

say(`seeding ${ITEMS} items, ${ESCALATIONS} questions, ${AGENTS} agents, ${PROJECTS} projects, ${EVENTS} events`);

await bulk('items', ITEMS, (index) => {
  const status = pick(STATUSES);
  const touched = ago(random() * 365);
  // A fleet files a few titles it never describes. They are what the partial
  // index is for, and seeding none of them would measure an empty index.
  const contentless = random() < 0.02;
  return {
    _id: newId('i'),
    projectId: main._id,
    slug: `${pick(LABELS)}:${index}-${Math.floor(random() * 1000)}`,
    title: `work item ${index} about ${pick(LABELS)} and ${pick(AGENT_HANDLES)}`,
    titleKey: `work item ${index}`,
    body: contentless ? '' : 'A description of the problem, long enough to be realistic but not a novel. '.repeat(3),
    status,
    owner: pick(OWNERS),
    priority: Math.floor(random() * 7) - 1,
    labels: [pick(LABELS), pick(LABELS)],
    fields: {},
    source: random() < 0.3 ? 'scanner' : null,
    stale: random() < 0.05,
    staleSince: null,
    lastActor: pick(AGENT_HANDLES),
    claim:
      status === 'open' && random() < 0.02
        ? { agent: pick(AGENT_HANDLES), expiresAt: new Date(now.getTime() + 3_600_000), heartbeatAt: now }
        : null,
    absence: { count: 0, since: null },
    timeline: Array.from({ length: contentless ? 0 : 5 }, (_, entry) => ({
      at: ago(random() * 365),
      by: pick(AGENT_HANDLES),
      kind: 'note' as const,
      message: `iteration ${entry}: what changed and why, in the words the agent used`,
    })),
    timelineCount: contentless ? 0 : 5,
    createdAt: ago(365),
    updatedAt: touched,
    touchedAt: touched,
    closedAt: status === 'done' || status === 'dropped' ? touched : null,
    expiresAt: null,
  } as unknown as ItemDoc;
}, store.items);

await bulk('escalations', ESCALATIONS, (index) => {
  const open = random() < 0.02;
  const created = ago(random() * 365);
  return {
    _id: newId('e'),
    projectId: main._id,
    agent: pick(AGENT_HANDLES),
    question: `Question ${index}: which of these two do we do, and who pays for it?`,
    context: 'Context an agent pasted, a few hundred characters of it. '.repeat(4),
    priority: 'normal',
    priorityRank: 1,
    status: open ? 'open' : 'answered',
    answer: open ? null : 'the decision, in the operator words',
    answeredAt: open ? null : new Date(created.getTime() + 3_600_000),
    notifiedAt: open ? null : created,
    itemSlug: null,
    acknowledgedAt: open ? null : new Date(created.getTime() + 7_200_000),
    acknowledgedBy: open ? null : pick(AGENT_HANDLES),
    acknowledgedNote: null,
    createdAt: created,
    updatedAt: created,
    expiresAt: null,
  } as unknown as EscalationDoc;
}, store.escalations);

await bulk('agents', AGENTS, (index) => ({
  _id: newId('a'),
  projectId: main._id,
  handle: `${pick(AGENT_HANDLES)}-${index}`,
  scope: [pick(LABELS)],
  description: 'one of the loops',
  meta: {},
  registeredAt: ago(300),
  lastSeenAt: ago(random() * 3),
  expiresAt: null,
}) as unknown as AgentDoc, store.agents);

await bulk('projects', PROJECTS, (index) => ({
  _id: newId('p'),
  name: `neighbour ${index}`,
  description: '',
  tier: 'free',
  limits: config.tiers.free,
  counts: { items: 20, agents: 3, escalations: 2 },
  rules: DEFAULT_RULES,
  board: DEFAULT_BOARD,
  readToken: newId('r', 16),
  claimedBy: index % 3 === 0 ? 'operator@example.com' : `somebody${index}@example.com`,
  claimedAt: ago(200),
  createdAt: ago(200),
  expiresAt: null,
  firstWriteAt: ago(200),
}) as unknown as ProjectDoc, store.projects);

await bulk('events', EVENTS, () => ({
  _id: newId('ev'),
  at: ago(random() * 90),
  kind: pick(['discover', 'view', 'signup', 'register', 'first_write', 'answer', 'escalate', 'move']),
  door: pick(['http', 'mcp', 'browser', 'oauth']),
  detail: pick(['skill.md', 'landing', 'board', 'project', null]),
  projectId: main._id,
  expiresAt: new Date(now.getTime() + 90 * 86_400_000),
}) as unknown as EventDoc, store.events);

const openItems = await store.items.countDocuments({ projectId: main._id, status: { $nin: ['done', 'dropped'] } });
const openQuestions = await store.escalations.countDocuments({ projectId: main._id, status: 'open' });
await store.projects.updateOne(
  { _id: main._id },
  { $set: { 'counts.items': openItems, 'counts.agents': AGENTS, 'counts.escalations': openQuestions } },
);
say(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s: ${openItems} open items, ${openQuestions} open questions\n`);

const { server } = await buildApp(config, store);
await server.ready();

/** Wall clock over a few runs, and what the planner had to read to answer. */
const timed = async (name: string, run: () => Promise<unknown>, rounds = 5) => {
  await run();
  const times: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const at = performance.now();
    await run();
    times.push(performance.now() - at);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  const worst = times[times.length - 1]!;
  say(`  ${name.padEnd(42)} ${median.toFixed(0).padStart(5)} ms   worst ${worst.toFixed(0)} ms`);
  return median;
};

const inject = (url: string, headers: Record<string, string> = {}) => () =>
  server.inject({ method: 'GET', url, headers }).then((response) => {
    if (response.statusCode !== 200) throw new Error(`${url} answered ${response.statusCode}`);
    return response.body.length;
  });

const authed = { authorization: `Bearer ${adminToken}` };
const api = `/v1/${main._id}`;

say('the API an agent uses');
await timed('GET /v1/:project (summary)', inject(api, authed));
await timed('GET /v1/:project/items?limit=50', inject(`${api}/items?limit=50`, authed));
await timed('GET /v1/:project/items?q=scanner+build', inject(`${api}/items?q=scanner build&limit=50`, authed));
await timed('GET /v1/:project/items?status=open&limit=200', inject(`${api}/items?status=open&limit=200`, authed));
await timed('GET /v1/:project/board', inject(`${api}/board`, authed));
await timed('GET /v1/:project/next?agent=errors-loop', inject(`${api}/next?agent=errors-loop`, authed));
await timed('GET /v1/:project/inbox', inject(`${api}/inbox`, authed));
await timed('GET /v1/:project/escalations?limit=50', inject(`${api}/escalations?limit=50`, authed));
// The same call again, once the sweep the first one kicked off has finished.
// Every read fires a throttled hygiene pass in the background, and on a board
// this size that pass is real work competing for the same database.
await timed('GET /v1/:project/items?limit=50 (again)', inject(`${api}/items?limit=50`, authed));

// Where the time in a page of items actually goes: the query, the service
// around it, or the route on top.
const { readItems } = await import('../src/service.js');
const fresh = (await store.projects.findOne({ _id: main._id }))!;
await timed('readItems({limit: 50}) in process', async () => readItems(store, fresh, { limit: 50 } as never));
await timed('the same page, straight from the driver', async () =>
  store.items
    .find({ projectId: main._id })
    .sort({ priority: -1, updatedAt: -1, _id: -1 })
    .limit(50)
    .toArray(),
);
// The one query in this service that cannot be indexed: a case insensitive
// substring, in either field, for every word. Measured with a word that matches
// almost nothing, which is the case that has to read the whole collection.
await timed('search for a common word', async () =>
  readItems(store, fresh, { q: 'build', limit: 50 } as never),
);
await timed('search for a word that matches nothing', async () =>
  readItems(store, fresh, { q: 'zzzznotathing', limit: 50 } as never),
);

say('\nthe work that runs beside the requests');
const { sweepProject, expireClaims, resolveAbsent, dropContentless, markStale, correctOvercount } =
  await import('../src/hygiene.js');
await timed('a full hygiene sweep of this board', async () => sweepProject(store, main), 3);
// Where a sweep spends itself, because it runs every five minutes per project
// and on the request path behind a throttle.
//
// Whichever of these touches an unindexed collection first pays for reading it:
// the same pass measured 680ms as the first thing to run and 70ms once the
// pages were in cache. So the line above is a cold number and the ones below it
// are warm ones, which is also the pair a deployment sees, the first sweep after
// a restart against every one after it.
await timed('  expireClaims', async () => expireClaims(store, main._id, new Date()), 3);
await timed('  resolveAbsent', async () => resolveAbsent(store, main._id, main.rules, new Date()), 3);
await timed('  dropContentless', async () => dropContentless(store, main._id, main.rules, new Date()), 3);
await timed('  markStale', async () => markStale(store, main._id, main.rules, new Date()), 3);
await timed('  correctOvercount', async () => correctOvercount(store, main._id), 3);
const { insights } = await import('../src/events.js');
await timed('the insights report', async () => insights(store), 3);

// The four distincts behind the filter dropdowns on the board page, measured
// before deciding whether they are worth an index each.
const { boardFacets } = await import('../src/board.js');
await timed('the board page facets', async () => boardFacets(store, (await store.projects.findOne({ _id: main._id }))!), 3);
// Split out, because the total says the board page costs a sixth of a second
// and not which of the four reads is spending it. Three of them are a walk of
// the distinct values; the fourth is an array field, and no index spares it the
// documents behind the keys.
await timed('  distinct owner', async () => store.items.distinct('owner', { projectId: main._id }), 3);
await timed('  distinct labels', async () => store.items.distinct('labels', { projectId: main._id }), 3);
await timed('  distinct lastActor', async () => store.items.distinct('lastActor', { projectId: main._id }), 3);
await timed('  distinct claim.agent (live only)', async () =>
  store.items.distinct('claim.agent', { projectId: main._id, 'claim.expiresAt': { $gt: new Date() } }),
  3,
);

say('\nthe pages a person opens');
await timed('GET /r/:token (the mail link)', inject(`/r/${main.readToken}`));
await timed('GET /r/:token/board', inject(`/r/${main.readToken}/board`));
await timed('GET /r/:token/board?q=security', inject(`/r/${main.readToken}/board?q=security`));

// The boards one person owns, which is what the operator page reads across.
const neighbourIds = (
  await store.projects.find({ claimedBy: 'operator@example.com' }, { projection: { _id: 1 } }).toArray()
).map((project) => project._id);

say(`\nwhat the planner had to read (operator owns ${neighbourIds.length} boards)`);
const explain = async (name: string, run: () => Promise<{ executionStats?: Record<string, unknown> }>) => {
  const plan = await run();
  const stats = plan.executionStats as { nReturned: number; totalDocsExamined: number; totalKeysExamined: number; executionTimeMillis: number } | undefined;
  if (!stats) return say(`  ${name}: no executionStats`);
  say(
    `  ${name.padEnd(42)} returned ${String(stats.nReturned).padStart(6)}   examined ${String(stats.totalDocsExamined).padStart(7)} docs, ${String(stats.totalKeysExamined).padStart(7)} keys   ${stats.executionTimeMillis} ms`,
  );
};

await explain('items by status, newest first', () =>
  store.items
    .find({ projectId: main._id, status: 'open' })
    .sort({ updatedAt: -1 })
    .limit(50)
    .explain('executionStats') as never,
);
await explain('the oldest unannounced question', () =>
  store.escalations
    .find({ projectId: main._id, status: 'open', notifiedAt: null })
    .sort({ createdAt: 1 })
    .limit(1)
    .explain('executionStats') as never,
);
await explain('the project page table, live work', () =>
  store.items
    .find({ projectId: main._id, status: { $in: ['blocked', 'open'] } })
    .sort({ priority: -1, touchedAt: 1 })
    .limit(25)
    .explain('executionStats') as never,
);
await explain('the project page table, the rest', () =>
  store.items
    .find({ projectId: main._id, _id: { $nin: ['i_none'] } })
    .sort({ updatedAt: -1 })
    .limit(25)
    .explain('executionStats') as never,
);
await explain('the inbox: answers not acted on', () =>
  store.escalations
    .find({ projectId: main._id, status: { $ne: 'open' }, acknowledgedAt: null })
    .sort({ answeredAt: -1 })
    .limit(50)
    .explain('executionStats') as never,
);
await explain('the inbox: questions still waiting', () =>
  store.escalations
    .find({ projectId: main._id, status: 'open' })
    .sort({ createdAt: 1 })
    .limit(50)
    .explain('executionStats') as never,
);
await explain('answered questions, newest first', () =>
  store.escalations
    .find({ projectId: main._id, status: { $ne: 'open' } })
    .sort({ answeredAt: -1 })
    .limit(50)
    .explain('executionStats') as never,
);
// The sorts below are the ones the code actually issues, tiebreaker included.
// An audit that measures a simpler sort measures an index that is never used.
await explain('the items list, urgency order', () =>
  store.items
    .find({ projectId: main._id })
    .sort({ priority: -1, updatedAt: -1, _id: -1 })
    .limit(50)
    .explain('executionStats') as never,
);
await explain('the items list, recent order', () =>
  store.items
    .find({ projectId: main._id })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(50)
    .explain('executionStats') as never,
);
await explain('the items list, stable order for an export', () =>
  store.items.find({ projectId: main._id }).sort({ _id: 1 }).limit(200).explain('executionStats') as never,
);
await explain('the board scan', () =>
  store.items
    .find({ projectId: main._id })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(1000)
    .explain('executionStats') as never,
);
await explain('search: two words in slug or title', () =>
  store.items
    .find({
      projectId: main._id,
      $and: [
        { $or: [{ slug: { $regex: 'build', $options: 'i' } }, { title: { $regex: 'build', $options: 'i' } }] },
      ],
    })
    .limit(50)
    .explain('executionStats') as never,
);
await explain('an operator queue across 67 boards', () =>
  store.escalations
    .find({ projectId: { $in: neighbourIds }, status: 'open' })
    .sort({ priorityRank: -1, createdAt: 1 })
    .limit(100)
    .explain('executionStats') as never,
);
await explain('work assigned to a person, everywhere', () =>
  store.items
    .find({
      projectId: { $in: neighbourIds },
      status: { $nin: ['done', 'dropped'] },
      $or: [{ owner: { $in: ['alex'] } }, { status: 'blocked' }, { 'claim.expiresAt': { $lte: new Date() } }],
    })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(40)
    .explain('executionStats') as never,
);
await explain('the stale list', () =>
  store.items
    .find({ projectId: { $in: neighbourIds }, stale: true, status: { $nin: ['done', 'dropped'] } })
    .sort({ staleSince: 1 })
    .limit(20)
    .explain('executionStats') as never,
);

/**
 * What the reads above cost the writes.
 *
 * Four indexes were added to make those numbers, and every one of them is paid
 * for on every write to the collection it sits on. An audit that measures only
 * the half it improved is an argument, not a measurement.
 */
const { upsertItem, appendNote, claimItem, releaseItem, createEscalation } = await import(
  '../src/service.js'
);
const { moveItem } = await import('../src/board.js');

// A hundred at a time, because one write is under a millisecond and the whole
// question here is what a fifth index adds to that. Timing single writes would
// print zero twice and prove nothing.
const BLOCK = 100;
const writes = async (label: string) => {
  say(`\n${label} (per ${BLOCK})`);
  const project = (await store.projects.findOne({ _id: main._id }))!;
  let n = 0;
  const block = (name: string, once: (index: number) => Promise<unknown>) =>
    timed(name, async () => {
      for (let index = 0; index < BLOCK; index += 1) await once(index);
    }, 3);

  await block('create an item', async () => {
    n += 1;
    return upsertItem(store, project, { slug: `perf:new-${label}-${n}`, title: 'a new item', actor: 'perf' });
  });
  await upsertItem(store, project, { slug: `perf:hot-${label}`, title: 'the same item, again', actor: 'perf' });
  await block('update the same item', async () =>
    upsertItem(store, project, { slug: `perf:hot-${label}`, title: 'the same item, again', body: 'changed', actor: 'perf' }),
  );
  await block('append a note', async () => appendNote(store, project, `perf:hot-${label}`, 'perf', 'a note'));
  await block('claim and release', async () => {
    await claimItem(store, project, `perf:hot-${label}`, 'perf', 5);
    return releaseItem(store, project, `perf:hot-${label}`, 'perf');
  });
  await block('move a card', async () =>
    moveItem(store, project, { slug: `perf:hot-${label}`, column: 'doing', actor: 'perf' }),
  );
  await block('file a question', async () => {
    n += 1;
    return createEscalation(store, project, { agent: 'perf', question: `a question ${n}` }, 'http');
  });
};

// The cap counts open items, and this board has twenty three thousand of them
// on purpose, so the writes below would be refused before they were measured.
// The audit lifts the cap rather than the tier: what is under test is what a
// write costs against a large collection, not the accounting that guards it.
await store.projects.updateOne(
  { _id: main._id },
  { $set: { tier: 'pro', limits: { ...config.tiers.pro, items: 10_000_000, escalations: 100_000 } } },
);

await writes('writes, with the indexes this service now has');

// Every index added today, plus `recent` back to the shape it had before the
// tiebreaker was appended. What is left is the index set of this morning.
for (const name of ['urgency', 'stable', 'stale', 'staleScan', 'owners', 'actors', 'undescribed']) {
  await store.items.dropIndex(name).catch(() => undefined);
}
for (const name of ['answered', 'unread']) {
  await store.escalations.dropIndex(name).catch(() => undefined);
}
await store.items.dropIndex('recent').catch(() => undefined);
await store.items.createIndexes([{ key: { projectId: 1, updatedAt: -1 }, name: 'recent' }]);

await writes('the same writes, on this morning\'s indexes');

await server.close();
await store.close();
await mongo.stop();
say(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s`);
