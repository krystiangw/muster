import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createStore, type Store } from '../src/db.js';
import type { RateLimiter } from '../src/rateLimit.js';

export interface Harness {
  server: FastifyInstance;
  store: Store;
  config: Config;
  limiter: RateLimiter;
  stop: () => Promise<void>;
}

export async function startHarness(overrides: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const mongo = await MongoMemoryServer.create();
  const config = loadConfig({
    MONGODB_URI: mongo.getUri(),
    MONGODB_DB: `muster_test_${Math.floor(Math.random() * 1e6)}`,
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
      await mongo.stop();
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
