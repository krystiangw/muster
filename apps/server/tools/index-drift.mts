#!/usr/bin/env -S npx tsx
/**
 * Does the deployment hold the indexes the code says it holds?
 *
 * Everything this service promises about forgetting is kept by a TTL index, and
 * everything it promises about one name meaning one thing is kept by a unique
 * one. `retention.test.ts` exists because a dropped or renamed index fails
 * nothing: the documents keep their dates, the code keeps writing them, and the
 * data simply stays for ever while every page still says ninety days.
 *
 * That test proves the code creates them. It cannot prove the deployment has
 * them, and those are different claims: indexes are built at boot, so a start
 * that failed halfway leaves a running service with a promise it no longer
 * keeps and nothing red anywhere.
 *
 * So this builds a database from the same code, reads both, and prints the
 * difference. Not part of the watchdog on purpose: that one deliberately shares
 * nothing with the database, and reaching into Mongo from it would couple the
 * monitor to the thing it watches. This is a thing to run after a schema change
 * and before saying a release landed.
 *
 *   MONGODB_URI=... npx tsx apps/server/tools/index-drift.mts
 *
 * Exits 1 on any difference, so it can stand in a release script.
 */
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createStore } from '../src/db.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'muster';
if (!uri) {
  console.error('Set MONGODB_URI. Nothing was read.');
  process.exit(2);
}

/**
 * Everything about an index that a promise can rest on.
 *
 * The name is deliberately not part of it: a renamed index keeps every promise,
 * and comparing names would report a difference nobody has to act on. What
 * matters is the keys, and the three flags that turn keys into a guarantee.
 */
const shape = (index: Record<string, unknown>): string =>
  [
    JSON.stringify(index.key),
    index.unique ? 'unique' : '',
    index.expireAfterSeconds === undefined ? '' : `ttl=${String(index.expireAfterSeconds)}`,
    index.partialFilterExpression ? `partial=${JSON.stringify(index.partialFilterExpression)}` : '',
    index.sparse ? 'sparse' : '',
  ]
    .filter(Boolean)
    .join(' ');

async function indexesOf(connection: string, database: string): Promise<Map<string, Set<string>>> {
  const client = await MongoClient.connect(connection);
  const found = new Map<string, Set<string>>();
  for (const collection of await client.db(database).listCollections({}, { nameOnly: true }).toArray()) {
    if (collection.name.startsWith('system.')) continue;
    const indexes = (await client
      .db(database)
      .collection(collection.name)
      .indexes()) as Array<Record<string, unknown>>;
    found.set(
      collection.name,
      new Set(indexes.filter((one) => one.name !== '_id_').map(shape)),
    );
  }
  await client.close();
  return found;
}

// The declaration, taken from a database this code has just built rather than
// from a list somebody has to remember to update.
const mongo = await MongoMemoryServer.create();
await createStore(mongo.getUri(), 'muster');
const declared = await indexesOf(mongo.getUri(), 'muster');
const live = await indexesOf(uri, dbName);
await mongo.stop();

const problems: string[] = [];
for (const [collection, wanted] of declared) {
  const have = live.get(collection) ?? new Set<string>();
  for (const one of wanted) if (!have.has(one)) problems.push(`missing   ${collection}  ${one}`);
}
// Reported, not tolerated. An index nobody declared is either a leftover from a
// shape this service has moved on from, or somebody's hand fixing a slow query
// in a way the code does not know about; both are worth a sentence.
for (const [collection, have] of live) {
  const wanted = declared.get(collection) ?? new Set<string>();
  for (const one of have) if (!wanted.has(one)) problems.push(`undeclared ${collection}  ${one}`);
}

const total = [...declared.values()].reduce((sum, set) => sum + set.size, 0);
for (const line of problems) console.log(line);
console.log(
  `${total} indexes declared across ${declared.size} collections; ${problems.length} difference${problems.length === 1 ? '' : 's'} in ${dbName}.`,
);
process.exit(problems.length === 0 ? 0 : 1);
