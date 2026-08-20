import assert from 'node:assert/strict';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOverrides } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createStore, type Store } from '../src/db.js';
import { hashToken } from '../src/ids.js';
import type { Notifier } from '../src/notify.js';
import type { RateLimiter } from '../src/rateLimit.js';

export interface Harness {
  server: FastifyInstance;
  store: Store;
  config: Config;
  limiter: RateLimiter;
  notifier: Notifier;
  stop: () => Promise<void>;
}

/**
 * One mongod per test file, not one per harness.
 *
 * node:test runs the files in parallel and several of them start a second
 * isolated harness mid-file, so a server each meant a dozen mongod processes
 * racing to boot, and one of them occasionally timing out. They are already
 * isolated by database name, which is the isolation the tests actually need.
 *
 * Standalone unless a file asks for a replica set, which one does: revoking an
 * admin key runs in a transaction, and a standalone refuses to start one. The
 * difference is not the 190 ms of extra boot but what comes after it, because
 * every write then goes through replication. Measured across the suite: 55
 * seconds standalone against 91 with every file on a replica set, so the file
 * that needs one asks for it and the rest stay as they were.
 */
let shared: Promise<MongoMemoryReplSet | MongoMemoryServer> | null = null;
let users = 0;

async function sharedMongo(replicaSet: boolean): Promise<MongoMemoryReplSet | MongoMemoryServer> {
  if (!shared) {
    shared = replicaSet ? MongoMemoryReplSet.create({ replSet: { count: 1 } }) : MongoMemoryServer.create();
  }
  users += 1;
  return shared;
}

async function releaseMongo(): Promise<void> {
  users -= 1;
  if (users > 0 || !shared) return;
  const mongo = await shared;
  shared = null;
  await mongo.stop();
}

export async function startHarness(
  overrides: NodeJS.ProcessEnv = {},
  build: BuildOverrides = {},
  /**
   * Ask for a replica set when the file under test reaches a transaction. Set
   * by the first harness in the file, because the server is shared by all of
   * them.
   */
  options: { replicaSet?: boolean } = {},
): Promise<Harness> {
  const mongo = await sharedMongo(options.replicaSet === true);
  const config = loadConfig({
    MONGODB_URI: mongo.getUri(),
    // Harnesses in one file share a mongod, so the database name is what keeps
    // them apart; the counter makes that a fact rather than a probability.
    MONGODB_DB: `muster_test_${users}_${Math.floor(Math.random() * 1e6)}`,
    BASE_URL: 'http://muster.test',
    LOG_LEVEL: 'silent',
    // Every test in a file shares one source address, so the production
    // creation limit would throttle the suite itself.
    LIMIT_CREATE_PROJECTS_PER_HOUR: '1000',
    ...overrides,
  });
  const store = await createStore(config.mongoUri, config.mongoDb);
  const { server, limiter, notifier } = await buildApp(config, store, build);

  /**
   * Every refusal this harness answers, by the route that answered it.
   *
   * The map of codes in the published document is written by hand, and twice in
   * one night it was found naming a code on one door while another door
   * answered it in silence. The test that guards it can only ask whether what
   * is written down happens, so a door that starts refusing says nothing.
   *
   * This asks the other question, and asks it of the whole suite rather than of
   * a list somebody keeps: whatever any test here provokes, on any route the
   * document describes, the document has to name. Routes hidden from the
   * document are hidden from this too, which is what keeps the browser doors
   * out without a list of exceptions.
   */
  const answered = new Map<string, Set<number>>();
  server.addHook('onSend', (request, reply, payload, done) => {
    const status = reply.statusCode;
    const pattern = request.routeOptions?.url;
    if (pattern && (status === 404 || status === 409)) {
      const path = pattern.replace(/:([A-Za-z_]+)/g, '{$1}');
      const key = `${request.method.toLowerCase()} ${path}`;
      const seen = answered.get(key) ?? new Set<number>();
      seen.add(status);
      answered.set(key, seen);
    }
    done(null, payload);
  });

  await server.ready();
  // Read once, while this server is healthy, because the last thing several
  // test files do is take the database away.
  const documented = (await server.inject({ method: 'GET', url: '/openapi.json' })).json()
    .paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>;

  return {
    server,
    store,
    config,
    limiter,
    notifier,
    stop: async () => {
      // Everything is put away first and the reading is judged after. The
      // first version asserted before this, and a failure then left the server,
      // the client and the mongod behind: the file reported one failure and the
      // process never exited.
      limiter.stop();
      await server.close();
      await store.close();
      await releaseMongo();
      refusalsAreOnTheMap(documented, answered);
    },
  };
}

export interface Project {
  id: string;
  token: string;
  readUrl: string;
  api: string;
}

export async function createProject(harness: Harness, name = 'test'): Promise<Project> {
  const response = await harness.server.inject({
    method: 'POST',
    url: '/p',
    payload: { name },
  });
  const body = response.json();
  return {
    id: body.project,
    token: body.token,
    readUrl: body.read_url,
    api: `/v1/${body.project}`,
  };
}

export function authed(project: Project): Record<string, string> {
  return { authorization: `Bearer ${project.token}` };
}

/**
 * A signed in operator, the way a person gets one: ask for a code, read it,
 * type it in. The code itself is planted, because only its hash is stored.
 *
 * Returns what every subsequent request needs: the cookie the browser would
 * send back, and the CSRF token the view renders into its forms.
 */
export interface OperatorSession {
  cookie: string;
  csrf: string;
  headers: Record<string, string>;
  form: (fields: Record<string, string>) => string;
}

export async function signIn(harness: Harness, email: string): Promise<OperatorSession> {
  await harness.server.inject({
    method: 'POST',
    url: '/operator',
    payload: `email=${encodeURIComponent(email)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const pending = await harness.store.operatorCodes.findOne({ email });
  if (!pending) throw new Error(`no code was minted for ${email}`);
  await harness.store.operatorCodes.updateOne(
    { _id: pending._id },
    { $set: { codeHash: hashToken('123456') } },
  );

  const verified = await harness.server.inject({
    method: 'POST',
    url: '/operator/verify',
    payload: `email=${encodeURIComponent(email)}&code=123456`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const setCookie = verified.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie ?? '');
  const cookie = raw.split(';')[0]!;
  if (!cookie.startsWith('muster_session=')) {
    throw new Error(`sign in did not set a session for ${email}: ${verified.statusCode}`);
  }

  const session = await harness.store.operatorSessions.findOne({ email }, { sort: { createdAt: -1 } });
  const csrf = session!.csrf;
  const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' };
  return {
    cookie,
    csrf,
    headers,
    form: (fields) =>
      new URLSearchParams({ csrf, ...fields }).toString(),
  };
}

/**
 * Checked as the harness comes down, so no test file has to remember to ask.
 *
 * Only what this harness actually answered, and only for operations the
 * document describes: a route hidden from the document is a browser door, and
 * those are not the contract this guards.
 */
function refusalsAreOnTheMap(
  documented: Record<string, Record<string, { responses?: Record<string, unknown> }>>,
  answered: Map<string, Set<number>>,
): void {
  const missing: string[] = [];
  for (const [key, codes] of answered) {
    const [method, path] = key.split(' ') as [string, string];
    const operation = documented?.[path]?.[method];
    if (!operation) continue;
    for (const code of codes) {
      if (!operation.responses?.[String(code)]) missing.push(`${method.toUpperCase()} ${path} answered ${code}`);
    }
  }
  assert.deepEqual(missing.sort(), [], 'every refusal these tests provoked is named in the document');
}
