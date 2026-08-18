#!/usr/bin/env -S npx tsx
/**
 * The whole service against a database that lives and dies with the process.
 *
 * For the checks that need a running Muster rather than an injected request:
 * the soak, a manual poke at a page, a client under development. Nothing it
 * writes survives, and it never touches a deployment.
 *
 *   npx tsx apps/server/tools/serve-memory.mts        # http://127.0.0.1:4600
 *   PORT=4700 npx tsx apps/server/tools/serve-memory.mts
 *   PORT=0 npx tsx apps/server/tools/serve-memory.mts    # any free port, printed
 *
 * The line it prints carries the address it actually bound, which is what makes
 * `PORT=0` useful to a script: nothing has to agree on a number in advance, and
 * a port somebody else is already holding cannot be mistaken for this one.
 *
 * The limits are lifted rather than merely raised. A soak fires thousands of
 * writes a minute from one address, and against production limits it would be
 * measuring the rate limiter.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/db.js';

const port = Number(process.env.PORT ?? 4600);
const mongo = await MongoMemoryServer.create();
const config = loadConfig({
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: 'memory',
  BASE_URL: `http://127.0.0.1:${port}`,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
  LIMIT_CREATE_PROJECTS_PER_HOUR: '100000',
  LIMIT_WRITES_PER_MINUTE: '100000',
  LIMIT_READS_PER_MINUTE: '100000',
});
const store = await createStore(config.mongoUri, config.mongoDb);
const { server } = await buildApp(config, store);
const address = await server.listen({ port, host: '127.0.0.1' });
console.log(`listening on ${address}`);

const stop = async () => {
  await server.close();
  await store.close();
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
