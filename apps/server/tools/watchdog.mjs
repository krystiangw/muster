#!/usr/bin/env node
/**
 * Notices that production stopped answering, and says so somewhere else.
 *
 * Two things this has to get right, and both are lessons the hygiene engine
 * already learned the hard way:
 *
 *  - **The alert cannot travel through the thing it watches.** Filing an
 *    escalation on the board is useless when the board is what is down, so the
 *    alert is an email, sent through the mail provider, which shares nothing
 *    with the dyno or the database. Filing on the board happens too, best
 *    effort, because a partial outage is the common case and the note belongs
 *    with the work.
 *  - **Two guards, never one.** A single failed request is a blip, and paging
 *    somebody for a blip teaches them to ignore the pager. It alerts on the
 *    second consecutive failure, and only once per outage.
 *
 * What it checks is deliberately not `/health`: that route answers without
 * touching the database, so it stays green through exactly the failure that
 * matters most. It reads a real project through the API instead.
 *
 *   node apps/server/tools/watchdog.mjs            # one round, quiet unless it matters
 *   node apps/server/tools/watchdog.mjs --status   # what it thinks right now
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = join(homedir(), '.muster');
const STATE = join(HOME, 'watchdog.state.json');
const TIMEOUT_MS = 15_000;
const ALERT_TO = process.env.MUSTER_ALERT_TO || 'gwizdala.kr@gmail.com';

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : { failures: 0, alerted: false, lastOk: null };

if (process.argv.includes('--status')) {
  console.log(JSON.stringify(state, null, 1));
  process.exit(0);
}

const tokens = JSON.parse(read(join(HOME, 'tokens.json')) ?? '{}');
const [projectId, entry] = Object.entries(tokens)[0] ?? [];
if (!projectId) {
  console.error('No project in ~/.muster/tokens.json, so there is nothing to read as a check.');
  process.exit(1);
}
const base = entry.base;

async function probe(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: String(error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// The page a person lands on, and a read that has to reach the database. Either
// one failing is an outage worth knowing about.
const checks = [
  { name: 'landing', ...(await probe(`${base}/`)) },
  {
    name: 'api read',
    ...(await probe(`${base}/v1/${projectId}`, {
      headers: { authorization: `Bearer ${entry.token}` },
    })),
  },
];
const broken = checks.filter((check) => !check.ok);
const now = new Date().toISOString();

async function mail(subject, lines) {
  const key = read(join(HOME, 'resend.key'));
  if (!key) return 'no key';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': 'muster-watchdog/1.0',
    },
    body: JSON.stringify({
      from: 'Muster watchdog <hello@musterboard.dev>',
      to: [ALERT_TO],
      subject,
      text: lines.join('\n'),
    }),
  });
  return response.ok ? 'sent' : `failed ${response.status}`;
}

/** Best effort, and never allowed to break the round. */
async function fileOnTheBoard(question, context) {
  try {
    const response = await fetch(`${base}/v1/${projectId}/escalations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${entry.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'watchdog', question, context, priority: 'urgent' }),
    });
    return response.ok ? 'filed' : `refused ${response.status}`;
  } catch {
    return 'unreachable, which is the point';
  }
}

if (broken.length === 0) {
  const recovered = state.alerted;
  Object.assign(state, { failures: 0, alerted: false, lastOk: now });
  if (recovered) {
    const delivery = await mail('Muster is answering again', [
      `${base} is back up as of ${now}.`,
      '',
      'The watchdog will stay quiet until something else breaks.',
    ]);
    console.log(`recovered, told you: ${delivery}`);
  }
} else {
  state.failures += 1;
  const detail = broken.map((c) => `${c.name}: ${c.status || c.error}`).join('; ');
  // The second consecutive miss, not the first. One failed request is weather.
  if (state.failures >= 2 && !state.alerted) {
    const delivery = await mail('Muster is not answering', [
      `${base} failed ${state.failures} checks in a row.`,
      '',
      detail,
      '',
      `Last seen healthy: ${state.lastOk ?? 'not since this watchdog started'}.`,
      '',
      'heroku logs -n 100 -a muster-web',
      'heroku ps -a muster-web',
    ]);
    const filed = await fileOnTheBoard(
      'Production stopped answering. Is this a deploy in progress or a real outage?',
      `${detail}. Last healthy ${state.lastOk ?? 'unknown'}.`,
    );
    state.alerted = true;
    console.log(`down: ${detail} | email ${delivery} | board ${filed}`);
  } else {
    console.log(`miss ${state.failures}: ${detail}`);
  }
}

mkdirSync(HOME, { recursive: true });
writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });
