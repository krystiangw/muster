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
 *   node apps/server/tools/backup.mjs --verify [file]                  # does it come back?
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

/**
 * Does the newest copy actually come back?
 *
 * An archive nobody has read is a promise, and this one had been a promise for
 * three days. Checked once by hand and then made a command, because a backup
 * verified in August is a backup unverified in September.
 *
 * It touches nothing that matters: no MONGODB_URI is read, and the archive is
 * poured into a database that exists for the length of this command. Running
 * it against production is not a thing somebody can do by accident here.
 *
 * What it does not check is the half after this one: that the server boots on
 * what came back and rebuilds its indexes. That was measured by hand the day
 * this was written, on the copy from that morning, and the recipe is in
 * docs/deploy.md rather than in here, because booting a server inside a backup
 * tool is a lot of machinery for a thing somebody does once a quarter.
 */
if (args.includes('--verify')) {
  const named = flag('verify');
  const file = named && !named.startsWith('--') ? named : listBackups().at(-1)?.path;
  if (!file) {
    console.error(`No backup to check in ${DIR}.`);
    process.exit(1);
  }
  let MemoryServer;
  try {
    ({ MongoMemoryServer: MemoryServer } = await import('mongodb-memory-server'));
  } catch {
    console.error(
      'This check needs mongodb-memory-server, which lives in the dev dependencies.\n' +
        'Run it from a checkout with `pnpm install`, or restore into a scratch database by hand.',
    );
    process.exit(1);
  }
  const mongod = await MemoryServer.create();
  const scratch = new MongoClient(mongod.getUri());
  const wrong = [];
  let total = 0;
  let at = 'an unreadable archive';
  let written = {};
  try {
    await scratch.connect();
    const into = scratch.db('verify');
    console.log(`checking ${file}`);
    const restored = await restoreInto(into, file, (line) => console.log(line));
    const archive = restored.archive;
    written = restored.written;
    at = archive.at;

    for (const [name, count] of Object.entries(written)) {
      const found = await into.collection(name).countDocuments({});
      total += found;
      if (found !== count) wrong.push(`${name}: archive says ${count}, ${found} came back`);
    }

    // An archive of nothing passes every count it has, which is the shape this
    // command exists to catch: losing a collection and keeping the file.
    if (total === 0) wrong.push('the archive holds no documents at all, which is not a copy of anything');
    if (total > 0 && (written.projects ?? 0) === 0) {
      wrong.push('the archive holds no projects, and everything else here belongs to one');
    }

    // Counts say the rows arrived and nothing about whether they are usable.
    // Compared against the archive's own text rather than against a guess at
    // which fields are dates: whatever was written as an ISO string has to
    // come back as a Date, or every query in this service that compares one is
    // quietly wrong.
    //
    // Every collection, not one. Sampling a single collection put this check
    // on whichever name sorted first, and a date that rotted in `items` sat
    // behind `agents` where nothing looked at it. One document each is enough
    // for the rot this format actually grows, which is a format change that
    // takes a whole collection with it rather than one row in the middle.
    for (const [name, count] of Object.entries(written)) {
      if (count === 0) continue;
      const raw = archive.collections[name][0];
      const back = await into.collection(name).findOne({ _id: raw._id });
      if (!back) {
        wrong.push(`${name}: the first document did not come back at all`);
        continue;
      }
      // Two rules, and the narrow one is the one that bites. The general rule
      // compares the archive with what came back: an ISO string in the file
      // has to be a Date in the database. It cannot see a date that was
      // already text in the file, because then the two agree and both are
      // wrong: that is what happens when the thing that wrote the archive
      // broke rather than the thing that reads it. So `createdAt` is named.
      // Every document this service writes has one, whatever else it holds.
      if ('createdAt' in raw && !(back.createdAt instanceof Date)) {
        wrong.push(`dates came back as text, not dates (${name}.createdAt)`);
      }
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
          if (!(back[key] instanceof Date)) wrong.push(`dates came back as text, not dates (${name}.${key})`);
        }
        if (Array.isArray(value) && !Array.isArray(back[key])) {
          wrong.push(`a list came back as something else (${name}.${key})`);
        }
      }
    }
  } catch (error) {
    wrong.push(`the archive could not be read back: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Whatever happened above, the scratch database goes away. A corrupt
    // archive is an expected input here, so the failing path is the one that
    // would otherwise leave a mongod and its directory behind every night.
    await scratch.close().catch(() => {});
    await mongod.stop().catch(() => {});
  }

  if (wrong.length > 0) {
    console.error(`\nThis copy does not come back cleanly:\n  ${wrong.join('\n  ')}`);
    process.exit(1);
  }

  // Said, never failed on. A collection that had rows and now has none is
  // worth an eyebrow and is not by itself wrong: emptying one is what a purge
  // looks like, and refusing to verify the copy taken after a deliberate one
  // would be the tool arguing with the operator. The line is the artefact; a
  // schedule keeps it in the log next to the exit code.
  // The one before this one, and only when this one is in that directory at
  // all. Taking the newest other copy read the future when an older archive
  // was named on the command line: the line then said a collection had been
  // emptied because it was filled afterwards. A file from somewhere else has
  // no place in this directory's order, so it is compared with nothing.
  const known = listBackups();
  const here = known.findIndex((b) => b.path === file);
  const older = here > 0 ? known[here - 1] : undefined;
  if (older) {
    try {
      const chunks = [];
      await pipeline(createReadStream(older.path), createGunzip(), async function* (source) {
        for await (const chunk of source) chunks.push(chunk);
      });
      const before = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const emptied = Object.entries(before.collections)
        .filter(([name, docs]) => docs.length > 0 && (written[name] ?? 0) === 0)
        .map(([name, docs]) => `${name} had ${docs.length} in ${older.name} and has none here`);
      if (emptied.length > 0) console.log(`\nworth a look:\n  ${emptied.join('\n  ')}`);
    } catch {
      // The older copy being unreadable says nothing about this one.
    }
  }

  console.log(`\n${total} documents came back from ${at}, counts and shapes intact.`);
  process.exit(0);
}

if (!uri) {
  console.error('Set MONGODB_URI. Nothing was read or written.');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
await client.connect();
const db = client.db(dbName);

/**
 * The way back in, used by the restore and by the check that the restore
 * works. One function rather than two, because a check that re-implements the
 * thing it checks is a check on the copy.
 */
async function restoreInto(target, file, say = () => {}) {
  const chunks = [];
  await pipeline(createReadStream(file), createGunzip(), async function* (source) {
    for await (const chunk of source) chunks.push(chunk);
  });
  const archive = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  say(`archive from ${archive.at}, database "${archive.db}"`);
  const written = {};
  for (const [name, docs] of Object.entries(archive.collections)) {
    await target.collection(name).deleteMany({});
    if (docs.length > 0) await target.collection(name).insertMany(docs.map(reviveDates));
    written[name] = docs.length;
    say(`  ${name}: ${docs.length} restored`);
  }
  return { archive, written };
}

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

  await restoreInto(db, restoring, (line) => console.log(line));
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
