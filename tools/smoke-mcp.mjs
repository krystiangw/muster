#!/usr/bin/env node
/**
 * The other door, driven the way an agent with an MCP client drives it.
 *
 * Most agents arrive over MCP rather than over curl, and nothing outside the
 * test suite has ever exercised that door against a deployment: the SDK smoke
 * speaks HTTP, and a change to the transport, the headers in front of it or the
 * shape of a tool result would pass everything and fail the first client.
 *
 *   node tools/smoke-mcp.mjs
 *   node tools/smoke-mcp.mjs --base http://127.0.0.1:4600
 *
 * It reuses the board `tools/smoke-sdk.mjs` keeps in ~/.muster/smoke.json, and
 * signs up only if there is none, for the reason written there: a check that
 * signs up on every run writes a signup event on every run, and that count is
 * the denominator of the conversion the product is judged by.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('--base');
const base = (at === -1 ? 'https://musterboard.dev' : argv[at + 1]).replace(/\/+$/, '');
// The operator's, unless a caller says otherwise. This script points at
// production by default and remembers what it made, and the only thing
// standing between it and being run against a server a test controls was the
// line that decides where that memory lives.
const HOME = process.env.MUSTER_HOME || join(homedir(), '.muster');
const STATE = join(HOME, 'smoke.json');

/**
 * How this names itself to the service, on every request.
 *
 * A smoke test registers a client and writes to a board, which is the same
 * shape as a stranger arriving, and the funnel counted it as one until the
 * service learned to tell them apart. The string is read and thrown away.
 */
const AS_US = 'muster-selftest smoke-mcp/1.0';

const rpc = async (method, params, token) => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'user-agent': AS_US,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`);
  if (body?.error) throw new Error(`${method}: ${body.error.message}`);
  return body?.result;
};

const call = async (name, args, token) => {
  const result = await rpc('tools/call', { name, arguments: args }, token);
  if (result?.isError) throw new Error(`${name}: ${JSON.stringify(result.content).slice(0, 200)}`);
  // Both halves, and the same answer in both, because a client reads one or the
  // other: a tool that filled the text with something else, or with a summary,
  // works in one client and misleads the next. Compared as text because both
  // arrived through the same serializer, in the same order.
  if (!result?.structuredContent) throw new Error(`${name}: no structuredContent`);
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error(`${name}: no text content`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name}: the text content is not the result, it is ${text.slice(0, 60)}`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(result.structuredContent)) {
    throw new Error(`${name}: the two halves of the result disagree`);
  }
  return result.structuredContent;
};

let failures = 0;
const step = async (name, run) => {
  try {
    console.log(`ok    ${name} ${(await run()) ?? ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} ${String(error).slice(0, 200)}`);
  }
};

const hello = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
console.log(`${hello.serverInfo.name} ${hello.serverInfo.version}, protocol ${hello.protocolVersion}`);

const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8'))[base] : null;
let project = saved?.project;
let token = saved?.token;
if (project) {
  // A board this tool kept can have expired, and the token dies with it.
  const alive = await fetch(`${base}/v1/${project}`, {
    headers: { 'user-agent': AS_US, authorization: `Bearer ${token}` },
  });
  if (alive.status === 404 || alive.status === 401) {
    console.log(`the saved board is gone (${alive.status}), signing up again`);
    project = undefined;
  } else if (!alive.ok) {
    // Anything else is the failure this tool exists to report. Signing up
    // around it would hide the broken route and write a signup event for the
    // privilege.
    console.error(`the saved board answered ${alive.status}, which is not expiry`);
    process.exit(1);
  }
}
if (!project) {
  const created = await call('create_project', { name: 'mcp smoke test', description: 'Created by tools/smoke-mcp.mjs.' });
  project = created.project;
  token = created.token;
  mkdirSync(HOME, { recursive: true });
  const all = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  all[base] = { project, token };
  writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 });
}
console.log(`board ${project} on ${base}`);

const tools = await rpc('tools/list', {});
await step('tools/list', async () => {
  const undescribed = tools.tools.filter((tool) => !tool.inputSchema).map((tool) => tool.name);
  if (undescribed.length > 0) throw new Error(`no input schema on ${undescribed.join(', ')}`);
  return `${tools.tools.length} tools, every one with a schema`;
});
// Flat, unlike the HTTP route's `{agent: ...}`: over MCP a tool result is read
// by a model, and one level of nesting is one more thing to get wrong.
await step('register_agent', async () => (await call('register_agent', { handle: 'mcp-smoke', scope: ['smoke:'] }, token)).handle);
await step('upsert_item', async () => (await call('upsert_item', { slug: 'smoke:mcp', title: 'work an MCP client wrote', status: 'open', actor: 'mcp-smoke' }, token)).item.slug);
await step('claim_item', async () => {
  const claimed = await call('claim_item', { slug: 'smoke:mcp', agent: 'mcp-smoke' }, token);
  return claimed.ok ? 'held' : `refused: ${claimed.held_by}`;
});
await step('append_note', async () => `${(await call('append_note', { slug: 'smoke:mcp', actor: 'mcp-smoke', message: 'the other door writes too' }, token)).item.timeline_count} timeline entries`);
await step('list_items', async () => `${(await call('list_items', { q: 'work' }, token)).items.length} found by search`);
await step('next_item', async () => {
  const next = await call('next_item', { agent: 'mcp-smoke' }, token);
  return next.item ? next.item.slug : `nothing: ${next.reason}`;
});
let asked = null;
await step('escalate', async () => {
  asked = (await call('escalate', { question: 'Does the MCP door reach the inbox?', agent: 'mcp-smoke', item_slug: 'smoke:mcp' }, token)).escalation.id;
  return asked;
});
await step('inbox', async () => {
  const inbox = await call('inbox', { agent: 'mcp-smoke' }, token);
  return `${inbox.waiting.length} waiting, ${inbox.answers.length} answered`;
});
await step('board', async () => {
  const view = await call('board', { items: false }, token);
  return view.totals.map((column) => `${column.key}:${column.count}`).join(' ');
});
await step('move', async () => {
  const moved = await call('move', { slug: 'smoke:mcp', column: 'done', agent: 'mcp-smoke' }, token);
  return `landed in ${moved.landed_in ?? 'nowhere'}`;
});
// Closed rather than left waiting, so a reused board does not collect one open
// question per run and hit the cap.
await step('answer over HTTP', async () => {
  if (!asked) return 'nothing was asked';
  const response = await fetch(`${base}/v1/${project}/escalations/${asked}`, {
    method: 'PATCH',
    headers: {
      'user-agent': AS_US,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ status: 'resolved', answer: 'closed by the MCP smoke test' }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // And acted on, which is what takes it out of the inbox. Without this a
  // reused board accumulates one unread answer per run, and the next run's
  // `inbox` step reports a number that says nothing about anything.
  const acted = await fetch(`${base}/v1/${project}/escalations/${asked}/ack`, {
    method: 'POST',
    headers: {
      'user-agent': AS_US,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agent: 'mcp-smoke', note: 'read by the smoke test' }),
  });
  if (!acted.ok) throw new Error(`ack: HTTP ${acted.status}`);
  return `${(await response.json()).escalation.status}, and acted on`;
});

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
