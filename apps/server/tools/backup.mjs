#!/usr/bin/env node
/**
 * A copy of everything, and the way back from it.
 *
 * The free Atlas tier takes no snapshots. Until somebody pays for one, the only
 * thing standing between a dropped collection and a stranger losing the board
 * they claimed is this file running on a schedule.
 *
 * It writes plain gzipped JSON rather than shelling out to `mongodump`, for one
 * reason: the archive has to be readable by anything, years later, on a machine
 * that has no mongo tools installed and no memory of which version wrote it.
 * Our whole database is a few megabytes of small documents; the trade is free.
 *
 *   MONGODB_URI=... node apps/server/tools/backup.mjs                  # write one
 *   MONGODB_URI=... node apps/server/tools/backup.mjs --list           # what is there
 *   MONGODB_URI=... node apps/server/tools/backup.mjs --restore <file> --yes
 *
 * Restore is refused without --yes, and refused outright against a database
 * that already holds projects unless --force says otherwise: the realistic
 * accident is restoring into production instead of a scratch copy.
 */
import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const DIR = flag('dir') ?? join(homedir(), '.muster', 'backups');
const KEEP = Number(flag('keep') ?? 7);
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'muster';

/** Everything, rather than a list somebody has to remember to extend. */
async function collectionNames(db) {
  const found = await db.listCollections({}, { nameOnly: true }).toArray();
  return found.map((c) => c.name).filter((name) => !name.startsWith('system.')).sort();
}

/** Dates survive the round trip; anything else Mongo-specific would not. */
function replacer(_key, value) {
  return value;
}

function reviveDates(value) {
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) value[key] = reviveDates(inner);
    return value;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return new Date(value);
  }
  return value;
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function listBackups() {
  try {
    return readdirSync(DIR)
      .filter((name) => name.startsWith('muster-') && name.endsWith('.json.gz'))
      .sort()
      .map((name) => ({ name, path: join(DIR, name), size: statSync(join(DIR, name)).size }));
  } catch {
    return [];
  }
}

if (args.includes('--list')) {
  const found = listBackups();
  for (const b of found) console.log(`${b.name}  ${(b.size / 1024).toFixed(1)} kB`);
  console.log(`${found.length} backup(s) in ${DIR}`);
  process.exit(0);
}

if (!uri) {
  console.error('Set MONGODB_URI. Nothing was read or written.');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
await client.connect();
const db = client.db(dbName);

const restoring = flag('restore');
if (restoring) {
  if (!args.includes('--yes')) {
    console.error(`Would restore ${restoring} into "${dbName}". Add --yes to carry it out.`);
    await client.close();
    process.exit(1);
  }
  const projects = await db.collection('projects').countDocuments({});
  if (projects > 0 && !args.includes('--force')) {
    console.error(
      `"${dbName}" already holds ${projects} project(s). Restoring would write over live data.\n` +
        'Point MONGODB_DB at a scratch database, or pass --force if this is the recovery you meant.',
    );
    await client.close();
    process.exit(1);
  }

  const chunks = [];
  await pipeline(createReadStream(restoring), createGunzip(), async function* (source) {
    for await (const chunk of source) chunks.push(chunk);
  });
  const archive = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(`archive from ${archive.at}, database "${archive.db}"`);

  for (const [name, docs] of Object.entries(archive.collections)) {
    await db.collection(name).deleteMany({});
    if (docs.length > 0) await db.collection(name).insertMany(docs.map(reviveDates));
    console.log(`  ${name}: ${docs.length} restored`);
  }
  await client.close();
  console.log('\nRestored. Indexes are rebuilt by the server on its next boot.');
  process.exit(0);
}

mkdirSync(DIR, { recursive: true });
const names = await collectionNames(db);
const collections = {};
let total = 0;
for (const name of names) {
  const docs = await db.collection(name).find({}).toArray();
  collections[name] = docs;
  total += docs.length;
  console.log(`  ${name.padEnd(20)} ${String(docs.length).padStart(6)}`);
}

const file = join(DIR, `muster-${stamp()}.json.gz`);
const body = JSON.stringify({ at: new Date().toISOString(), db: dbName, collections }, replacer);
await pipeline(
  (async function* () {
    yield body;
  })(),
  createGzip({ level: 9 }),
  createWriteStream(file, { mode: 0o600 }),
);

// Rotation last, so a failed write never costs us the copies we already had.
const kept = listBackups();
for (const old of kept.slice(0, Math.max(0, kept.length - KEEP))) {
  unlinkSync(old.path);
  console.log(`  dropped ${old.name}`);
}

console.log(`\n${total} documents -> ${file} (${(statSync(file).size / 1024).toFixed(1)} kB)`);
console.log(`keeping the last ${KEEP}, ${listBackups().length} on disk`);
await client.close();
