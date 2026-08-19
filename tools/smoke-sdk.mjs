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
 * Needs no token the first time: it signs itself up, which is the first call on
 * the list anyway, and keeps what that returned in ~/.muster/smoke.json so the
 * next run reuses the same board. That is not tidiness. A tool that signs up on
 * every run writes a signup event on every run, and that number is the
 * denominator of the activation and claim rates, so a check that runs on every
 * deploy would quietly make the product look like it converts nobody. The
 * board it keeps is unclaimed, so the service deletes it on its own timer, and
 * the next run notices and signs up again.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

// The operator's, unless a caller says otherwise. This script points at
// production by default and remembers what it made, and the only thing
// standing between it and being run against a server a test controls was the
// line that decides where that memory lives.
const HOME = process.env.MUSTER_HOME || join(homedir(), '.muster');
const STATE = join(HOME, 'smoke.json');
/**
 * Which entry in that file is this script's.
 *
 * Keyed like the other two rather than by the address alone, which this and the
 * MCP check shared: each run handed the other its board, and the counts one of
 * them printed were partly the other one's work.
 */
const key = `${base}#sdk`;
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8'))[key] : null;

/**
 * The name this smoke test goes by, added around the SDK rather than inside it.
 *
 * Deliberately not a header the published client sends: somebody else's agent
 * using this SDK is a stranger, and marking every SDK user as one of our own
 * checks would break the very count this is here to keep honest. Ours is ours
 * because this file says so.
 */
const asUs = (input, init = {}) =>
  fetch(input, { ...init, headers: { ...(init.headers ?? {}), 'user-agent': 'muster-selftest smoke-sdk/1.0' } });

const signUp = async () => {
  const { client, created } = await Muster.start({
    name: 'sdk smoke test',
    description: 'Created by tools/smoke-sdk.mjs. Unclaimed, so it expires on its own.',
    actor: 'sdk-smoke',
    baseUrl: base,
    fetch: asUs,
  });
  mkdirSync(HOME, { recursive: true });
  const all = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  all[key] = { project: created.project, token: created.token };
  // In a home directory rather than anywhere near a checkout, for the reason
  // every other token here lives there: a token file inside a repository is
  // eventually committed.
  writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 });
  return { client, how: 'signed up as' };
};

const reuse = async () => {
  const client = new Muster({
    project: saved.project,
    token: saved.token,
    actor: 'sdk-smoke',
    baseUrl: base,
    fetch: asUs,
  });
  // The board expires on its own once nobody claims it, and the token dies with
  // it, so a saved one is a guess until it answers.
  await client.summary();
  return { client, how: 'reusing' };
};

const { client, how } = saved
  ? await reuse().catch(async (error) => {
      // Gone is 404 or a token that no longer opens anything. Anything else,
      // a bad minute on the provider, a 500, a response this package cannot
      // parse, is the failure this tool exists to report, and signing up
      // around it would both hide it and write the signup this run avoids.
      if (error?.status !== 404 && error?.status !== 401) throw error;
      console.log(`the board from last time is gone (${error.status}), signing up again`);
      return signUp();
    })
  : await signUp();
console.log(`${how} ${client.project} on ${base}`);

await step('summary', async () => {
  const summary = await client.summary();
  return `claimed=${summary.claimed} notice_sent_at=${summary.notice_sent_at}`;
});
await step('registerAgent', async () => (await client.registerAgent({ handle: 'sdk-smoke', scope: ['smoke:'] })).agent.handle);
// `status: 'open'` on purpose, and load bearing on a reused board: without it
// the item stays `done` from last time, the move below is not a transition, and
// so it does not release the claim. The release at the end would then be an
// ordinary release of live work rather than the case this tool was written for,
// and it would pass while the regression was back.
await step('upsert', async () => (await client.upsert({ slug: 'smoke:one', title: 'work the SDK wrote', status: 'open', priority: 1 })).item.slug);
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
let asked = null;
await step('escalate', async () => {
  asked = (await client.escalate({ question: 'Does the published SDK reach the inbox?', agent: 'sdk-smoke', item_slug: 'smoke:one' })).escalation.id;
  return asked;
});
await step('inbox', async () => {
  const inbox = await client.inbox();
  return `${inbox.waiting.length} waiting, ${inbox.answers.length} answered`;
});
await step('board', async () => (await client.board()).totals.map((column) => `${column.key}:${column.count}`).join(' '));
await step('move', async () => {
  const landed = await client.move('smoke:one', 'done');
  // Read back rather than assumed. The release below is only the case this tool
  // was written for if closing actually let go of the claim, and an item that
  // was already done would move without transitioning and keep it.
  const { item } = await client.item('smoke:one');
  if (item.claim !== null) throw new Error('closing did not release the claim, so the next step proves nothing');
  return `landed in ${landed.landed_in ?? 'nowhere'}, claim cleared`;
});
// Last on purpose: closing released the claim, so this is the call that arrives
// with nothing to do, which is the one that used to fail.
await step('release after close', async () => `took it: ${(await client.release('smoke:one', 'sdk-smoke')).ok}`);
// Closed rather than left waiting. A board this tool reuses would otherwise
// collect one open question per run and hit the cap on the twenty first, and
// every deploy after that would read as a broken SDK.
await step('answer', async () => (asked ? `${(await client.answer(asked, 'resolved', 'closed by the smoke test')).escalation.status}` : 'nothing was asked'));

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
