#!/usr/bin/env -S node --import tsx
/**
 * The whole service, locally, with a board that has something on it.
 *
 * The suite proves behaviour and the walkthrough proves the deployment. Neither
 * lets anybody look at the operator's own pages, which is where a person
 * actually lives and where two of the defects reported from a browser were.
 * Production cannot fill that gap: signing in there means waiting for a code in
 * somebody's inbox.
 *
 * So: an in-memory MongoDB, the real app on a real port, a project seeded with
 * work that looks like work, and the six digit code planted as `123456` so the
 * sign in can be walked in a browser like any other.
 *
 *   node --import tsx apps/server/tools/local-lab.mts
 *   node --import tsx apps/server/tools/local-lab.mts --port 3100
 *
 * Nothing here touches production, and nothing here ships: it is a laboratory,
 * and the data in it is invented.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createStore } from '../src/db.js';
import type { Delivery } from '../src/email.js';
import { hashToken } from '../src/ids.js';
import { startEmailClaim, verifyClaimCode } from '../src/service.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const PORT = Number(flag('--port') ?? 3100);
const EMAIL = flag('--email') ?? 'operator@example.com';
const CODE = '123456';

const mongo = await MongoMemoryServer.create();
const config = loadConfig({
  MONGODB_URI: mongo.getUri(),
  MONGODB_DB: 'muster_lab',
  BASE_URL: `http://localhost:${PORT}`,
  LOG_LEVEL: 'warn',
  LIMIT_CREATE_PROJECTS_PER_HOUR: '1000',
});
const store = await createStore(config.mongoUri, config.mongoDb);
/** Nothing leaves the laboratory, and the code is printed instead of sent. */
const delivered = (what: string): Promise<Delivery> => {
  console.log(`  mail: ${what}`);
  return Promise.resolve('logged');
};
const { server, limiter } = await buildApp(config, store, {
  mailer: {
    sendOperatorCode: (to, code) => delivered(`sign in code for ${to} is ${code}`),
    sendClaimCode: (to, code, projectName) =>
      delivered(`claim code for ${projectName} to ${to} is ${code}`),
    sendEscalation: (to, notice) => delivered(`question for ${to}: ${notice.question}`),
    sendBoardOffer: (to, offer) =>
      delivered(`board "${offer.projectName}" offered to ${to} at ${offer.readUrl}`),
  },
});
await server.listen({ port: PORT, host: '127.0.0.1' });

const base = `http://localhost:${PORT}`;
const post = async (path: string, body: unknown, token?: string) => {
  const answer = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return answer.json() as Promise<any>;
};

const made = await post('/p', {
  name: 'venue-ops',
  description: 'Six loops watching two venues, one person deciding.',
});
const api = `/v1/${made.project}`;
const token = made.token as string;

for (const agent of [
  { handle: 'errors-loop', scope: ['errors:'], description: 'classifies runtime errors' },
  { handle: 'market-loop', scope: ['market:'], description: 'watches depth and spreads' },
  { handle: 'ops-loop', scope: ['ops:'], description: 'keys, backups, the boring half' },
]) {
  await post(`${api}/agents`, agent, token);
}

const items = [
  {
    slug: 'errors:withdraw-stuck',
    title: 'Withdraws stuck in pending for forty minutes',
    body: 'Three tickets from one user and one from support. The venue answers, the signer answers, so it is somewhere between them.',
    actor: 'errors-loop',
    priority: 6,
    labels: ['withdraw'],
  },
  {
    slug: 'market:depth-check-eu',
    title: 'Depth check times out on the EU venue',
    body: 'Twice in an hour, both times at the top of the minute.',
    actor: 'market-loop',
    priority: 3,
    owner: 'alex',
  },
  {
    slug: 'ops:key-rotation',
    title: 'Read link rotated after handover',
    body: 'The old link stopped working, which is the point of rotating it.',
    actor: 'ops-loop',
    priority: 0,
    status: 'done',
  },
  {
    slug: 'ops:bridge-or-wait',
    title: 'Bridge it, or wait for the direct route?',
    body: 'A large position is parked behind a bridge with no direct withdraw to a tradeable pair.',
    actor: 'errors-loop',
    priority: 7,
    status: 'blocked',
    owner: 'alex',
  },
  {
    slug: 'market:pair-listing',
    title: 'New pair listed, watcher running',
    actor: 'market-loop',
    priority: -2,
    status: 'done',
  },
];
for (const item of items) await post(`${api}/items`, item, token);

await post(`${api}/items/errors:withdraw-stuck/timeline`, {
  actor: 'errors-loop',
  message: 'Venue support says the batch is queued behind a maintenance window.',
}, token);
await post(`${api}/items/errors:withdraw-stuck/claim`, { agent: 'errors-loop', ttl_minutes: 60 }, token);

for (const asked of [
  {
    agent: 'errors-loop',
    question: 'Refund the user while the venue investigates, or wait for the batch?',
    context: 'Pool depth rejected in the timeline of errors:withdraw-stuck.',
    priority: 'high',
    item_slug: 'errors:withdraw-stuck',
  },
  {
    agent: 'ops-loop',
    question: 'Bridge the position via the third venue, or wait for a direct withdraw?',
    context: 'Two days of waiting so far.',
    item_slug: 'ops:bridge-or-wait',
  },
]) {
  await post(`${api}/escalations`, asked, token);
}

// Claimed, because an unclaimed project shows the operator an empty page: the
// laboratory exists to look at the populated one. Through the service, with the
// code read straight out of the store, which is the same two steps the read
// link walks a person through.
const claimed = await store.projects.findOne({ _id: made.project });
if (claimed) {
  await startEmailClaim(store, claimed, EMAIL, config, {
    sendClaimCode: async (to, code) => {
      console.log(`  mail: claim code for ${to} is ${code}`);
      return 'logged';
    },
  });
  const pending = await store.claimCodes.findOne({ projectId: made.project });
  if (pending) {
    await store.claimCodes.updateOne({ _id: pending._id }, { $set: { codeHash: hashToken(CODE) } });
    await verifyClaimCode(store, claimed, EMAIL, CODE, config);
  }
}

/**
 * The code, planted as it is minted.
 *
 * Only its hash is stored, which is right, and which also means nobody can
 * read it back out of the laboratory. Watching the collection and rewriting
 * the hash is the same trick the suite uses to sign in.
 */
setInterval(() => {
  void store.operatorCodes
    .updateMany({ codeHash: { $ne: hashToken(CODE) } }, { $set: { codeHash: hashToken(CODE) } })
    .catch(() => undefined);
}, 400);

console.log(`
  ${base}                      the landing page
  ${base}${made.read_url.replace(base, '')}            the read link
  ${base}${made.read_url.replace(base, '')}/board      the board
  ${base}/operator                 sign in as ${EMAIL}, the code is always ${CODE}
                                    (any other address signs in to an empty page:
                                    the board below is claimed by that one)

  project ${made.project}
  token   ${token}

  Ctrl-C stops it and throws the database away.
`);

const stop = async () => {
  limiter.stop();
  await server.close();
  await store.close();
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
