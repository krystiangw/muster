#!/usr/bin/env node
/**
 * The soak, against a server that exists only for it.
 *
 * `tools/soak.mjs` needs something to talk to, and pointing it at a deployment
 * means writing thousands of items into a real database and measuring a rate
 * limiter. This starts the service on an in-memory MongoDB, runs the workload,
 * prints the verdict and takes it all down again.
 *
 *   node tools/soak-local.mjs          # 400 rounds of 8 concurrent operations
 *   node tools/soak-local.mjs 1000
 *
 * It found a real one on 2026-08-18: the open counter drifting below the
 * collection, permanently, because nothing repairs a counter that is too low.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.PORT ?? 4601);
const BASE = `http://127.0.0.1:${PORT}`;
const rounds = process.argv[2] ?? '400';

const server = spawn('npx', ['tsx', 'apps/server/tools/serve-memory.mts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const done = new Promise((resolve) => server.on('exit', resolve));

const up = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      // Not listening yet. Mongo takes a moment to come up the first time it is
      // asked to, and a great deal longer if it has to download itself.
    }
    await sleep(1000);
  }
  return false;
};

if (!(await up())) {
  console.error('the server never answered, so there is nothing to soak');
  server.kill('SIGTERM');
  process.exit(1);
}

const soak = spawn('node', ['tools/soak.mjs', rounds], {
  env: { ...process.env, BASE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const verdict = await new Promise((resolve) => soak.on('exit', resolve));

server.kill('SIGTERM');
await Promise.race([done, sleep(5000)]);
process.exit(verdict ?? 0);
