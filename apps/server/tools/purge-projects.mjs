#!/usr/bin/env node
/**
 * Deletes named projects and everything that belongs to them.
 *
 * The service has no delete button and should not have one: an unclaimed
 * project expires by itself, and a claimed one is somebody's board. What this
 * is for is the other case, the smoke tests and probes an operator creates
 * against their own deployment while building it, which otherwise sit in the
 * list forever and count as signups in the funnel.
 *
 *   node apps/server/tools/purge-projects.mjs                       # list what is there
 *   node apps/server/tools/purge-projects.mjs --ids p_a,p_b         # say what would go
 *   node apps/server/tools/purge-projects.mjs --ids p_a,p_b --yes   # do it
 *
 * Ids are explicit, always. A filter ("everything unclaimed", "everything
 * older than") is how somebody deletes a real board at four in the afternoon,
 * and the saving over pasting a few ids is not worth that.
 *
 * MONGODB_URI and MONGODB_DB come from the environment, so pointing it at
 * production is a deliberate act:
 *
 *   MONGODB_URI="$(heroku config:get MONGODB_URI -a muster-web)" node ...
 */
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const ids = (flag('--ids') ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');
const confirmed = args.includes('--yes');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Set MONGODB_URI. Nothing was touched.');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'muster');

/**
 * Everything that carries a projectId, so nothing is left orphaned.
 *
 * `oauthClients` is the one that is easy to forget: a project created through
 * RFC 7591 registration has a client credential keyed to it, and leaving that
 * behind leaves a credential for a project that no longer exists.
 */
const OWNED = [
  'items',
  'agents',
  'escalations',
  'apiKeys',
  'claimCodes',
  'shares',
  'handoverRequests',
  'oauthClients',
  'events',
];

const summarise = (project) =>
  [
    project._id,
    (project.createdAt?.toISOString() ?? '').slice(0, 16).replace('T', ' '),
    project.claimedBy ? `claimed by ${project.claimedBy}` : 'unclaimed',
    `items=${project.counts?.items ?? 0} agents=${project.counts?.agents ?? 0} questions=${
      project.counts?.escalations ?? 0
    }`,
    JSON.stringify(project.name),
  ].join('  ');

if (ids.length === 0) {
  const all = await db.collection('projects').find({}).sort({ createdAt: 1 }).toArray();
  for (const project of all) console.log(summarise(project));
  console.log(`\n${all.length} project(s). Pass --ids to name the ones to delete.`);
  await client.close();
  process.exit(0);
}

const found = await db.collection('projects').find({ _id: { $in: ids } }).toArray();
const missing = ids.filter((id) => !found.some((project) => project._id === id));
for (const id of missing) console.log(`${id}  not here already`);

console.log(`\n${confirmed ? 'Deleting' : 'Would delete'}:`);
for (const project of found) console.log(`  ${summarise(project)}`);

const counts = {};
for (const name of OWNED) {
  counts[name] = await db.collection(name).countDocuments({ projectId: { $in: ids } });
}
console.log(
  `\nand what belongs to them: ${Object.entries(counts)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ')}`,
);

if (!confirmed) {
  console.log('\nDry run. Add --yes to carry it out.');
  await client.close();
  process.exit(0);
}

for (const name of OWNED) {
  const gone = await db.collection(name).deleteMany({ projectId: { $in: ids } });
  console.log(`${name}: ${gone.deletedCount} deleted`);
}
const gone = await db.collection('projects').deleteMany({ _id: { $in: ids } });
console.log(`projects: ${gone.deletedCount} deleted`);

await client.close();
