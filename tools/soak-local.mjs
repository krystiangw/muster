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
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const rounds = process.argv[2] ?? '400';
// Generous, and a bound rather than a guess: the first run on a machine has to
// download a MongoDB binary before it can listen at all.
const READY_TIMEOUT_MS = Number(process.env.SOAK_STARTUP_MS ?? 300_000);


// Through the workspace that has it. `tsx` is a dependency of the server, not
// of the repository root, so a root `npx` goes to the registry for a copy of
// something `pnpm install` already put on this disk.
//
// On a port of its own choosing, and the address comes back from the child.
// Agreeing on a number in advance is how a soak ends up writing thousands of
// items into whatever else happens to be listening: another copy of this
// server, or a development one pointed at a real database. Both answer /health
// exactly as ours would.
const server = spawn('pnpm', ['--dir', 'apps/server', 'exec', 'tsx', 'tools/serve-memory.mts'], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let serverExit = null;
const done = new Promise((resolve) =>
  server.on('exit', (code, signal) => {
    serverExit = { code, signal };
    resolve();
  }),
);

const address = await new Promise((resolve) => {
  const lines = createInterface({ input: server.stdout });
  lines.on('line', (line) => {
    console.log(line);
    const listening = /listening on (http:\/\/\S+)/.exec(line);
    if (listening) resolve(listening[1]);
  });
  // Either of the two ways this ends without an address: the child died, or it
  // is taking longer than any first run reasonably does.
  void done.then(() => resolve(null));
  void sleep(READY_TIMEOUT_MS).then(() => resolve(null));
});

if (address === null) {
  console.error(
    serverExit
      ? `the server exited before it was listening (${serverExit.signal ?? `code ${serverExit.code}`})`
      : 'the server never said where it was listening, so there is nothing to soak',
  );
  server.kill('SIGTERM');
  process.exit(1);
}
const BASE = address;

const soak = spawn('node', ['tools/soak.mjs', rounds], {
  env: { ...process.env, BASE },
  stdio: ['ignore', 'inherit', 'inherit'],
});
// A run killed by a signal reports no code at all, and reading that as zero
// would turn an out-of-memory kill into a release check that passed.
const verdict = await new Promise((resolve) =>
  soak.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1))),
);

server.kill('SIGTERM');
await Promise.race([done, sleep(5000)]);
process.exit(verdict);
