import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createStore, type Store } from '../src/db.js';
import { hashToken } from '../src/ids.js';
import type { RateLimiter } from '../src/rateLimit.js';

export interface Harness {
  server: FastifyInstance;
  store: Store;
  config: Config;
  limiter: RateLimiter;
  stop: () => Promise<void>;
}

/**
 * One mongod per test file, not one per harness.
 *
 * node:test runs the files in parallel and several of them start a second
 * isolated harness mid-file, so a server each meant a dozen mongod processes
 * racing to boot, and one of them occasionally timing out. They are already
 * isolated by database name, which is the isolation the tests actually need.
 */
let shared: Promise<MongoMemoryServer> | null = null;
let users = 0;

async function sharedMongo(): Promise<MongoMemoryServer> {
  if (!shared) shared = MongoMemoryServer.create();
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

export async function startHarness(overrides: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const mongo = await sharedMongo();
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
  const { server, limiter } = await buildApp(config, store);
  await server.ready();

  return {
    server,
    store,
    config,
    limiter,
    stop: async () => {
      limiter.stop();
      await server.close();
      await store.close();
      await releaseMongo();
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
