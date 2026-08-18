#!/usr/bin/env node
/**
 * Does the package we publish still work against the service we run?
 *
 * Not the workspace build, and not a tarball: this installs `musterboard` from
 * the registry into a temporary directory and drives production through it, the
 * way an agent that read `/skill.md` and ran `npm install musterboard` does.
 * The two halves of that promise are released separately, and a server change
 * that breaks the published client is invisible to a suite that only ever
 * imports the source next door.
 *
 * It found the first thing it looked for: `release` after `close` answered 409,
 * because closing an item releases its claim, so the release an agent runs in
 * its `finally` arrives second.
 *
 *   node tools/smoke-sdk.mjs
 *   node tools/smoke-sdk.mjs --base http://localhost:4600 --version 0.1.0
 *
 * Needs no token: it signs itself up, which is the first call on the list
 * anyway. The project it creates is unclaimed, so the service deletes it on its
 * own timer.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const base = flag('base', 'https://musterboard.dev');
const version = flag('version', 'latest');

const dir = mkdtempSync(join(tmpdir(), 'muster-smoke-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'muster-smoke', private: true, type: 'module' }));
console.log(`installing musterboard@${version} into ${dir}`);
execFileSync('npm', ['install', '--silent', `musterboard@${version}`], { cwd: dir, stdio: 'inherit' });

// Imported from the install rather than from anywhere in this checkout, and
// through a file that only names the package, so the resolution is the one a
// consumer gets: whatever the published `exports` says, not a path we guessed.
// A relative import here would quietly test the code we already test.
writeFileSync(join(dir, 'entry.mjs'), "export { Muster } from 'musterboard';\n");
const { Muster } = await import(pathToFileURL(join(dir, 'entry.mjs')).href);

let failures = 0;
const step = async (name, run) => {
  try {
    console.log(`ok    ${name} ${(await run()) ?? ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} ${String(error).slice(0, 200)}`);
  }
};

const { client } = await Muster.start({
  name: 'sdk smoke test',
  description: 'Created by tools/smoke-sdk.mjs. Unclaimed, so it expires on its own.',
  actor: 'sdk-smoke',
  baseUrl: base,
});
console.log(`signed up as ${client.project} on ${base}`);

await step('summary', async () => {
  const summary = await client.summary();
  return `claimed=${summary.claimed} notice_sent_at=${summary.notice_sent_at}`;
});
await step('registerAgent', async () => (await client.registerAgent({ handle: 'sdk-smoke', scope: ['smoke:'] })).agent.handle);
await step('upsert', async () => (await client.upsert({ slug: 'smoke:one', title: 'work the SDK wrote', priority: 1 })).item.slug);
await step('claim', async () => {
  const claimed = await client.claim('smoke:one', 'sdk-smoke', 10);
  return claimed.ok ? `held until ${claimed.expires_at}` : `refused: held by ${claimed.held_by}`;
});
await step('heartbeat', async () => `lease extended: ${(await client.heartbeat('smoke:one', 'sdk-smoke')).ok}`);
await step('note', async () => `${(await client.note('smoke:one', 'the published package can write')).item.timeline_count} timeline entries`);
await step('items(q)', async () => `${(await client.items({ q: 'work' })).items.length} found by search`);
await step('next', async () => {
  const next = await client.next('sdk-smoke');
  return next.item ? next.item.slug : `nothing: ${next.reason}`;
});
await step('escalate', async () => (await client.escalate({ question: 'Does the published SDK reach the inbox?', agent: 'sdk-smoke', item_slug: 'smoke:one' })).escalation.id);
await step('inbox', async () => {
  const inbox = await client.inbox();
  return `${inbox.waiting.length} waiting, ${inbox.answers.length} answered`;
});
await step('board', async () => (await client.board()).totals.map((column) => `${column.key}:${column.count}`).join(' '));
await step('move', async () => `landed in ${(await client.move('smoke:one', 'done')).landed_in ?? 'nowhere'}`);
// Last on purpose: closing released the claim, so this is the call that arrives
// with nothing to do, which is the one that used to fail.
await step('release after close', async () => `took it: ${(await client.release('smoke:one', 'sdk-smoke')).ok}`);

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
