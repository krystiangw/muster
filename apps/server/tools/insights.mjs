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

const [
  discovered,
  signups,
  registered,
  firstWrites,
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
] = await Promise.all([
  count(events, { kind: 'discover' }),
  count(events, { kind: 'signup' }),
  events.aggregate([{ $match: { kind: 'register', projectId: { $ne: null } } }, { $group: { _id: '$projectId' } }, { $count: 'n' }]).toArray(),
  count(events, { kind: 'first_write' }),
  count(events, { kind: { $in: ['claim', 'accept'] } }),
  events.aggregate([{ $match: { kind: 'signup' } }, { $group: { _id: '$door', n: { $sum: 1 } } }]).toArray(),
  events.aggregate([{ $match: { kind: 'discover' } }, { $group: { _id: '$detail', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  count(projects),
  count(projects, { claimedBy: { $ne: null } }),
  count(projects, { visibility: 'owner' }),
  count(items, { status: { $nin: ['done', 'dropped'] } }),
  count(agents),
  count(escalations, { status: 'open' }),
  count(items, { stale: true, status: { $nin: ['done', 'dropped'] } }),
  escalations.find({ answeredAt: { $ne: null } }, { projection: { createdAt: 1, answeredAt: 1 } }).sort({ answeredAt: -1 }).limit(500).toArray(),
  projects.find({}, { projection: { name: 1, counts: 1 } }).sort({ 'counts.items': -1 }).limit(5).toArray(),
  count(events, { kind: 'signup', at: { $gte: since(7) } }),
  count(events, { kind: 'first_write', at: { $gte: since(7) } }),
  events.aggregate([{ $match: { kind: 'view' } }, { $group: { _id: '$detail', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  count(events, { kind: 'view', at: { $gte: since(7) } }),
  count(events, { kind: 'move' }),
  count(events, { kind: 'view', detail: 'board' }),
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
row('reads of the protocol', discovered);
row('created a project', signups);
row('registered an agent', registered[0]?.n ?? 0);
row('wrote something', firstWrites);
row('claimed by a person', claims);
console.log(`  ${'reads per signup'.padEnd(28)} ${discovered === 0 ? '  n/a' : (discovered / Math.max(signups, 1)).toFixed(1).padStart(5)}`);
console.log(`  ${'signup -> wrote something'.padEnd(28)} ${rate(firstWrites, signups)}`);
console.log(`  ${'signup -> claimed'.padEnd(28)} ${rate(claims, signups)}`);

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
row('median answer, hours', median === null ? 'n/a' : median.toFixed(1));
if (hours.length > 0) console.log(`  ${'  over the last'.padEnd(28)} ${String(hours.length).padStart(7)} answers`);

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
