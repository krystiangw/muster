#!/usr/bin/env node
/**
 * Walks a live deployment the way its two readers do, and says what broke.
 *
 * The suite proves the code does what the code says. This proves the deployed
 * thing still behaves, through the doors a stranger actually uses: the protocol
 * an agent follows out of skill.md, and the HTML a person is handed a link to.
 *
 * It exists because three real defects were found by hand in one evening and
 * none of them could have been found by a unit test: a card that carried a
 * question and said nothing about it, a navigation that told a signed in reader
 * to sign in, and a sheet that opened by fragment on a page that reloads itself.
 * Every one of them lived in the gap between "the function returns the right
 * string" and "the page in front of somebody is right".
 *
 *   node apps/server/tools/walkthrough.mjs
 *   node apps/server/tools/walkthrough.mjs --url http://localhost:3000
 *   node apps/server/tools/walkthrough.mjs --fresh      # a new project, not the kept one
 *   node apps/server/tools/walkthrough.mjs --mail       # and say so by email if it broke
 *
 * The mail goes through the provider rather than through the board, for the
 * reason the watchdog already learned: an alert that travels through the thing
 * it watches is an alert nobody gets on the day it matters.
 *
 * One project, kept between runs in ~/.muster/walkthrough.json and keyed by the
 * deployment it belongs to. A tool that signs up every time it runs is a tool
 * that puts its own noise in the funnel it is meant to watch, and the product's
 * own advice to an agent is to look before creating a second project.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const BASE = (flag('--url') || 'https://musterboard.dev').replace(/\/$/, '');
const FRESH = args.includes('--fresh');
const MAIL = args.includes('--mail');
const HOME = join(homedir(), '.muster');
const STATE = join(HOME, 'walkthrough.json');
const ALERT_TO = process.env.MUSTER_ALERT_TO || 'gwizdala.kr@gmail.com';
const AGENT = 'probe-loop';
const SLUG = 'probe:the-card';
const QUESTION = 'Walkthrough probe: does this reach a person?';

const failures = [];
const ok = (what) => console.log(`  ok    ${what}`);
const check = (what, condition, detail) => {
  if (condition) return ok(what);
  failures.push(what);
  console.log(`  FAIL  ${what}${detail ? `\n        ${String(detail).slice(0, 300)}` : ''}`);
};

/** Said outside the service, because the service is what is being doubted. */
async function mail(subject, lines) {
  const keyPath = join(HOME, 'resend.key');
  if (!existsSync(keyPath)) return 'no key';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${readFileSync(keyPath, 'utf8').trim()}`,
      'content-type': 'application/json',
      'user-agent': 'muster-walkthrough/1.0',
    },
    body: JSON.stringify({
      from: 'Muster walkthrough <hello@musterboard.dev>',
      to: [ALERT_TO],
      subject,
      text: lines.join('\n'),
    }),
  });
  return response.ok ? 'sent' : `failed ${response.status}`;
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const saveState = () => {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
};

const json = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: response.status, body, headers: response.headers };
};
const html = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual', ...options });
  return { status: response.status, body: await response.text(), headers: response.headers };
};

/** The project this walkthrough owns, reused unless it is gone or refused. */
async function project() {
  const kept = state[BASE];
  if (kept && !FRESH) {
    const check = await json(`/v1/${kept.project}`, {
      headers: { authorization: `Bearer ${kept.token}` },
    });
    if (check.status === 200) return kept;
    console.log(`  note  the kept project is gone (${check.status}), signing up again`);
  }
  const made = await json('/p', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'walkthrough', description: 'Automated walkthrough of this deployment.' }),
  });
  if (made.status !== 200 && made.status !== 201) {
    throw new Error(`signup answered ${made.status}: ${JSON.stringify(made.body).slice(0, 200)}`);
  }
  const fresh = {
    project: made.body.project,
    token: made.body.token,
    readToken: String(made.body.read_url).split('/r/')[1],
  };
  state[BASE] = fresh;
  saveState();
  console.log(`  note  new project ${fresh.project}`);
  return fresh;
}

async function mcp(token, method, params) {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const start = text.indexOf('{');
  return start === -1 ? {} : JSON.parse(text.slice(start));
}

const run = async () => {
  console.log(`walkthrough of ${BASE}`);
  const { project: id, token, readToken } = await project();
  const api = `/v1/${id}`;
  const authed = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const board = `/r/${readToken}/board`;

  console.log('\nwhat an agent finds before it signs up');
  // The names an agent probes on its way in. A refactor that moves one of them
  // is a product nobody can find the protocol for, and every one of them is
  // cheap to ask for.
  for (const [path, marker, type] of [
    ['/skill.md', '# Muster', 'text/markdown'],
    ['/llms.txt', 'musterboard', 'text/plain'],
    ['/.well-known/agent-access.json', 'signup', 'application/json'],
    ['/.well-known/mcp.json', 'mcp', 'application/json'],
    ['/openapi.json', '"openapi"', 'application/json'],
    ['/docs', 'Muster', 'text/html'],
  ]) {
    const found = await html(path);
    check(
      `${path} answers, and says what it is`,
      found.status === 200 &&
        (found.headers.get('content-type') ?? '').includes(type) &&
        found.body.includes(marker),
      `${found.status} ${found.headers.get('content-type')}`,
    );
  }

  console.log('\nthe agent door');
  const registered = await json(`${api}/agents`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ handle: AGENT, scope: ['probe:'], description: 'walks this deployment' }),
  });
  check('an agent can register', [200, 201, 409].includes(registered.status), registered.status);

  const filed = await json(`${api}/items`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({
      slug: SLUG,
      title: 'The card this walkthrough reads',
      body: 'Filed by the walkthrough. Safe to close, safe to delete with the project.',
      actor: AGENT,
      priority: 2,
    }),
  });
  check('an item can be filed under a stable slug', filed.body?.item?.slug === SLUG, filed.status);

  const nearMiss = await json(`${api}/items`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ slug: `${SLUG}-typo`, title: 'A second spelling', actor: 'probe_loop' }),
  });
  check(
    'a near miss of a registered handle is named',
    (nearMiss.body?.warnings ?? []).some((line) => line.includes(AGENT)),
    JSON.stringify(nearMiss.body?.warnings),
  );

  const open = await json(`${api}/escalations?status=open`, { headers: authed });
  let escalation = (open.body?.escalations ?? []).find((one) => one.question === QUESTION);
  if (!escalation) {
    const asked = await json(`${api}/escalations`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ agent: AGENT, question: QUESTION, item_slug: SLUG, context: 'Nothing is blocked on the answer.' }),
    });
    escalation = asked.body?.escalation;
  }
  check('a question can be asked about an item', typeof escalation?.id === 'string', JSON.stringify(open.body).slice(0, 200));

  console.log('\nthe person door');
  const closed = await html(board);
  check('the board answers', closed.status === 200, closed.status);
  check('and reloads itself', closed.body.includes('http-equiv="refresh"'));
  check('and varies by the cookie it is drawn for', /cookie/i.test(closed.headers.get('vary') ?? ''));
  check('and offers a stranger the sign in', closed.body.includes('>sign in</a>'));
  // The other branch of the same sentence. The navigation is drawn from the
  // presence of the session cookie and nothing else, deliberately: no page
  // should read the database to decide one word. So any cookie exercises it,
  // which is the only way this tool can reach the branch at all without an
  // inbox to take a code out of.
  const known = await html(board, { headers: { cookie: 'muster_session=walkthrough' } });
  check('and calls somebody signed in by their own name', known.body.includes('>your projects</a>'));
  check(
    'a card links to its own address',
    closed.body.includes(`href="${board}?card=${encodeURIComponent(SLUG)}#`),
  );
  check('and carries no sheet until one is asked for', !closed.body.includes('class="peeked'));
  check(
    'a card with a question says so on its face',
    closed.body.includes('<span class="chip asks">'),
  );

  const opened = await html(`${board}?card=${encodeURIComponent(SLUG)}`);
  check('the address opens the sheet', opened.body.includes('class="peeked open"'));
  check('with the question on it', opened.body.includes(QUESTION));
  check('with somewhere to write a note', opened.body.includes(`action="${board}/note"`));
  check('and the page holds still while it is open', !opened.body.includes('http-equiv="refresh"'));

  // As a browser posts it, not as curl does. A form on a page with a
  // `Referrer-Policy: no-referrer` sends `Origin: null`, and for twenty one
  // hours those two correct headers cancelled each other out and refused every
  // write on our own board. A check that posts without them is green through
  // exactly that outage.
  const answered = await html(`/r/${readToken}/escalations/${escalation.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    },
    body: 'status=answered&answer=Yes.+This+is+the+walkthrough+answering+itself.&back=board',
  });
  check('an answer posts from the board', answered.status === 303, answered.status);
  check(
    'and comes back saying which question it was',
    (answered.headers.get('location') ?? '').includes(`answered=${escalation.id}`),
  );

  const inbox = await json(`${api}/inbox?agent=${AGENT}`, { headers: authed });
  check(
    'the agent reads the answer back',
    (inbox.body?.answers ?? []).some((one) => one.id === escalation.id),
    JSON.stringify(inbox.body).slice(0, 200),
  );

  const noted = await html(`${board}/note`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE,
      'sec-fetch-site': 'same-origin',
    },
    body: `slug=${encodeURIComponent(SLUG)}&message=${encodeURIComponent('The walkthrough was here.')}`,
  });
  check('a note posts from the board as a browser posts it', noted.status === 303, noted.status);

  const elsewhere = await html(`${board}/note`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://not-this-service.example',
      'sec-fetch-site': 'cross-site',
    },
    body: `slug=${encodeURIComponent(SLUG)}&message=${encodeURIComponent('From somewhere else.')}`,
  });
  check('and the same form posted from another site is refused', elsewhere.status === 403, elsewhere.status);

  console.log('\nthe same board over MCP');
  const tools = await mcp(token, 'tools/list', {});
  check('the tools are listed', (tools.result?.tools ?? []).length > 0);
  const over = await mcp(token, 'tools/call', {
    name: 'upsert_item',
    arguments: { slug: `${SLUG}-mcp`, title: 'Filed over MCP', actor: 'probe_loop' },
  });
  check(
    'and a write through it is warned about the same spelling',
    (over.result?.structuredContent?.warnings ?? []).some((line) => line.includes(AGENT)),
    JSON.stringify(over.result?.structuredContent?.warnings),
  );

  console.log(
    `\n${failures.length === 0 ? 'all clear' : `${failures.length} broken:\n  - ${failures.join('\n  - ')}`}`,
  );
  console.log(`project ${id} kept for the next run; purge with tools/purge-projects.mjs --ids ${id}`);
  if (MAIL && failures.length > 0) {
    const said = await mail(`Muster walkthrough: ${failures.length} broken`, [
      `${BASE} answers, and behaves differently than it is meant to:`,
      '',
      ...failures.map((line) => `  - ${line}`),
      '',
      'Run it yourself: node apps/server/tools/walkthrough.mjs',
    ]).catch((error) => `failed ${error.message}`);
    console.log(`mail ${said}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
};

run().catch(async (error) => {
  // The loudest failure of all goes through here: a deployment that does not
  // answer never reaches a single check, so a mail sent only for accumulated
  // failures is a mail that arrives for everything except an outage.
  console.error(`walkthrough could not finish: ${error.message}`);
  if (MAIL) {
    const said = await mail('Muster walkthrough: could not finish', [
      `${BASE} did not get far enough to be checked.`,
      '',
      `  ${error.message}`,
      '',
      'Run it yourself: node apps/server/tools/walkthrough.mjs',
    ]).catch((failure) => `failed ${failure.message}`);
    console.error(`mail ${said}`);
  }
  process.exit(2);
});
