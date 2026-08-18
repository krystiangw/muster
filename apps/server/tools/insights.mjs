/**
 * What the service knows about how it is being used, printed to a terminal.
 *
 * Deliberately not a page. This is the operator of the service looking at their
 * own service, not a feature of it, and serving it would mean minting another
 * credential to protect it, on a product whose security notes are mostly about
 * how few of those there should be.
 *
 *   MONGODB_URI=... MONGODB_DB=muster node apps/server/tools/insights.mjs
 *   MONGODB_URI="$(heroku config:get MONGODB_URI -a muster-web)" node apps/server/tools/insights.mjs
 *
 * It lives under apps/server because that is where the Mongo driver is
 * installed; the tools at the repository root only ever speak HTTP.
 *
 * Reads only. It never writes, so running it against production is safe.
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? 'muster';
if (!uri) {
  console.error('MONGODB_URI is not set. For production:');
  console.error('  MONGODB_URI="$(heroku config:get MONGODB_URI -a muster-web)" node apps/server/tools/insights.mjs');
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

const events = db.collection('events');
const projects = db.collection('projects');
const items = db.collection('items');
const agents = db.collection('agents');
const escalations = db.collection('escalations');

const count = (collection, filter = {}) => collection.countDocuments(filter);
const since = (days) => new Date(Date.now() - days * 86_400_000);

// Two of the numbers below are about people rather than about traffic, and both
// need the same condition: the board had an owner when the answer was given. A
// board nobody claimed has no person on it, whatever answered there held the
// project token, and "when it was given" rather than "now" keeps a board
// claimed today from dragging in every answer its automation gave last week.
// A join rather than a collected list of ids, which grows with the service.
const answeredByPerson = [
  { $lookup: { from: 'projects', localField: 'projectId', foreignField: '_id', as: 'project' } },
  { $unwind: '$project' },
  { $match: { 'project.claimedBy': { $ne: null } } },
];

const [
  discovered,
  signups,
  registered,
  firstWrites,
  asked,
  claims,
  doorRows,
  fileRows,
  projectCount,
  claimedCount,
  privateCount,
  openItems,
  agentCount,
  openQuestions,
  staleItems,
  answered,
  busiest,
  weekSignups,
  weekWrites,
  pageRows,
  weekViews,
  moves,
  boardViews,
  unswept,
  oldestSweep,
  refusedRows,
  answerDoorRows,
] = await Promise.all([
  count(events, { kind: 'discover' }),
  count(events, { kind: 'signup' }),
  events.aggregate([{ $match: { kind: 'register', projectId: { $ne: null } } }, { $group: { _id: '$projectId' } }, { $count: 'n' }]).toArray(),
  count(events, { kind: 'first_write' }),
  events.aggregate([{ $match: { kind: 'handover_request', projectId: { $ne: null } } }, { $group: { _id: '$projectId' } }, { $count: 'n' }]).toArray(),
  events.aggregate([{ $match: { kind: { $in: ['claim', 'accept'] }, projectId: { $ne: null } } }, { $group: { _id: '$projectId' } }, { $count: 'n' }]).toArray(),
  events.aggregate([{ $match: { kind: 'signup' } }, { $group: { _id: '$door', n: { $sum: 1 } } }]).toArray(),
  events.aggregate([{ $match: { kind: 'discover' } }, { $group: { _id: '$detail', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  count(projects),
  count(projects, { claimedBy: { $ne: null } }),
  count(projects, { visibility: 'owner' }),
  count(items, { status: { $nin: ['done', 'dropped'] } }),
  count(agents),
  count(escalations, { status: 'open' }),
  count(items, { stale: true, status: { $nin: ['done', 'dropped'] } }),
  escalations.aggregate([
    { $match: { answeredAt: { $ne: null } } },
    ...answeredByPerson,
    { $match: { $expr: { $gte: ['$answeredAt', '$project.claimedAt'] } } },
    // Next to the limit rather than before the join, so the two coalesce into a
    // top five hundred rather than a sort of every answer ever given.
    { $sort: { answeredAt: -1 } },
    { $limit: 500 },
    { $project: { createdAt: 1, answeredAt: 1 } },
  ]).toArray(),
  projects.find({}, { projection: { name: 1, counts: 1 } }).sort({ 'counts.items': -1 }).limit(5).toArray(),
  count(events, { kind: 'signup', at: { $gte: since(7) } }),
  count(events, { kind: 'first_write', at: { $gte: since(7) } }),
  events.aggregate([{ $match: { kind: 'view' } }, { $group: { _id: '$detail', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  count(events, { kind: 'view', at: { $gte: since(7) } }),
  count(events, { kind: 'move' }),
  count(events, { kind: 'view', detail: 'board' }),
  // Hygiene, across every project rather than the one the watchdog reads: a
  // board nobody is sweeping looks exactly like a board with nothing to sweep.
  count(projects, { 'counts.items': { $gt: 0 }, $or: [{ sweptAt: null }, { sweptAt: { $exists: false } }] }),
  projects
    .find({ 'counts.items': { $gt: 0 }, sweptAt: { $ne: null } }, { projection: { sweptAt: 1 } })
    .sort({ sweptAt: 1 })
    .limit(1)
    .toArray(),
  events.aggregate([{ $match: { kind: 'refused' } }, { $group: { _id: '$detail', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  events.aggregate([
    { $match: { kind: 'answer', projectId: { $ne: null } } },
    ...answeredByPerson,
    { $match: { $expr: { $gte: ['$at', '$project.claimedAt'] } } },
    { $group: { _id: '$door', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray(),
]);

const hours = answered
  .map((doc) => (doc.answeredAt.getTime() - doc.createdAt.getTime()) / 3_600_000)
  .filter((value) => value >= 0)
  .sort((a, b) => a - b);
const median = hours.length === 0 ? null : hours[Math.floor(hours.length / 2)];
const rate = (part, whole) => (whole === 0 ? '  n/a' : `${((part / whole) * 100).toFixed(0).padStart(4)}%`);
const row = (label, value) => console.log(`  ${label.padEnd(28)} ${String(value).padStart(7)}`);

console.log(`\nMuster, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n`);

console.log('The funnel, since events were first recorded');
// Said out loud, because the section below counts documents rather than
// events, and the two disagree by construction: a project claimed before this
// log existed is claimed on the board and absent from the funnel. Reading that
// as a contradiction is how somebody ends up "fixing" a number that is right.
console.log('  (events, not documents: anything that happened before this log started is missing)');
row('reads of the protocol', discovered);
row('created a project', signups);
row('registered an agent', registered[0]?.n ?? 0);
row('wrote something', firstWrites);
row('claimed by a person', claims[0]?.n ?? 0);
console.log(`  ${'reads per signup'.padEnd(28)} ${discovered === 0 ? '  n/a' : (discovered / Math.max(signups, 1)).toFixed(1).padStart(5)}`);
console.log(`  ${'signup -> wrote something'.padEnd(28)} ${rate(firstWrites, signups)}`);
console.log(`  ${'signup -> claimed'.padEnd(28)} ${rate(claims[0]?.n ?? 0, signups)}`);
// Beside the funnel, not in it: asking is not a stage every claim passes
// through, and a stage that can exceed the one above it stops being believed.
// It exists because "nobody claimed one" has two explanations, and this tells
// them apart.
row('asked to be handed a board', asked[0]?.n ?? 0);

if (doorRows.length > 0) {
  console.log('\nWhich door they came through');
  for (const { _id, n } of doorRows.sort((a, b) => b.n - a.n)) row(_id ?? 'unknown', n);
}

if (fileRows.length > 0) {
  console.log('\nWhat they read');
  for (const { _id, n } of fileRows) row(_id ?? 'unknown', n);
}

// People, not agents. Crawlers are dropped where the view is recorded, and the
// two capability pages are counted by kind so no token ever reaches this log.
if (pageRows.length > 0) {
  console.log('\nPages people opened');
  for (const { _id, n } of pageRows) row(_id ?? 'unknown', n);
  row('  in the last seven days', weekViews);
  // The number that decides whether drag and drop was refused on evidence or
  // on taste. Above roughly three moves per board view, the refusal is wrong.
  //
  // Blind between 2026-08-17 09:37Z and 2026-08-18 06:55Z: `Referrer-Policy:
  // no-referrer` blanked the Origin on our own forms and the same-site check
  // refused every move posted in those twenty one hours. A zero covering that
  // window is a broken form, not a preference, and reading it as evidence is
  // how a feature gets refused twice for the same wrong reason.
  row('cards moved by hand', moves);
  row('  per board view', boardViews === 0 ? 0 : (moves / boardViews).toFixed(2));
}

console.log('\nOn the boards right now');
row('projects', projectCount);
row('  of those, claimed', claimedCount);
row('  of those, private', privateCount);
row('open items', openItems);
row('  of those, stale', staleItems);
row('agents', agentCount);
row('questions waiting', openQuestions);
const sweepAgeMinutes =
  oldestSweep.length > 0
    ? Math.round((Date.now() - new Date(oldestSweep[0].sweptAt).getTime()) / 60_000)
    : null;
row(
  'longest since a sweep, min',
  sweepAgeMinutes === null ? 'n/a' : sweepAgeMinutes,
);
// Printed whether or not it is zero, like every count above it: a row that
// disappears when it is healthy leaves a reader unable to tell the healthy
// answer from a number nobody collected.
row('  boards never swept', unswept);

// Does the accounting agree with the work? The cap is enforced from the
// counter, so a counter that has drifted is a project quietly refusing work or
// quietly allowing too much of it. The repair fixes overcounts on its own; this
// says whether it is keeping up, and it is the only place an undercount shows
// at all.
//
// The candidates are chosen without looking at the number under audit. Picking
// them by the counter hid the very case worth finding: a counter that drifted
// to zero while work is still open would have been filtered out as an idle
// project. So both ends are asked, the boards with the most open work and the
// boards claiming the most, and every candidate is then counted exactly.
const CHECKED = 50;
const [byWork, byCounter] = await Promise.all([
  items
    .aggregate([
      { $match: { status: { $nin: ['done', 'dropped'] } } },
      { $group: { _id: '$projectId', open: { $sum: 1 } } },
      { $sort: { open: -1 } },
      { $limit: CHECKED },
    ])
    .toArray(),
  projects
    .find({ 'counts.items': { $gt: 0 } }, { projection: { name: 1, counts: 1 } })
    .sort({ 'counts.items': -1 })
    .limit(CHECKED)
    .toArray(),
]);
const candidateIds = [...new Set([...byWork.map((row) => row._id), ...byCounter.map((p) => p._id)])];
const candidates = await projects
  .find({ _id: { $in: candidateIds } }, { projection: { name: 1, counts: 1 } })
  .toArray();
const drifted = [];
for (const project of candidates) {
  const open = await items.countDocuments({
    projectId: project._id,
    status: { $nin: ['done', 'dropped'] },
  });
  if (open !== project.counts.items) {
    drifted.push({ project, open, counter: project.counts.items });
  }
}
row('counters checked', candidates.length);
row('  of those, drifted', drifted.length);
for (const entry of drifted.slice(0, 5)) {
  console.log(
    `    ${(entry.project.name ?? entry.project._id).slice(0, 24).padEnd(24)} counter ${entry.counter}, open ${entry.open}`,
  );
}
row('median answer, hours', median === null ? 'n/a' : median.toFixed(1));
if (hours.length > 0) console.log(`  ${'  over the last'.padEnd(28)} ${String(hours.length).padStart(7)} answers`);

// Ordinarily zero, and printed whether or not it is: a browser refused as
// somebody else's page gets a page and tells nobody, and the agents never meet
// this check at all. `cross-site` and `origin` climbing together is somebody
// probing the forms; either one climbing while the boards are quiet is this
// service refusing pages it served itself, which is what it did for a night.
// The mail sends people to the capability link, the operator page is where
// somebody who signed in ends up, and an agent's own operator can answer over
// the API. A door that is used and a door that is refused look identical from
// anywhere else, and the refused one is the one that gets removed for being
// unused. Both browser doors count as `browser`; which page it was is not worth
// a second field, since the question this settles is whether people answer from
// a browser at all.
if (answerDoorRows.length > 0) {
  console.log('\nHow the answers arrived');
  for (const { _id, n } of answerDoorRows) row(_id ?? 'unknown', n);
}

console.log('\nForms refused as somebody else\'s page');
row('all of them', refusedRows.reduce((total, { n }) => total + n, 0));
for (const { _id, n } of refusedRows) row(`  ${_id ?? 'unknown'}`, n);

console.log('\nLast seven days');
row('signups', weekSignups);
row('signups that wrote', weekWrites);

if (busiest.length > 0) {
  console.log('\nBusiest projects');
  for (const project of busiest) {
    console.log(
      `  ${(project.name ?? project._id).slice(0, 28).padEnd(28)} ${String(project.counts?.items ?? 0).padStart(7)} items, ${project.counts?.agents ?? 0} agents`,
    );
  }
}

if (discovered === 0 && signups === 0) {
  console.log('\nNothing recorded yet. Events started on the release that added them,');
  console.log('so everything before that is invisible here and always will be.');
}

console.log();
await client.close();
