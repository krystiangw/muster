#!/usr/bin/env node
/**
 * Imports an operator-inbox-app store into Muster.
 *
 * The operator inbox is one markdown file per decision, station wide, across
 * every project. Muster keeps escalations inside the project they belong to and
 * gives the human one page across all of them, so the import creates one Muster
 * project per source project and files each question where it came from.
 *
 * Dry run by default. Nothing is written until you pass --apply.
 *
 *   node tools/import-operator-inbox.mjs --base http://localhost:4600
 *   node tools/import-operator-inbox.mjs --base https://muster.dev --apply
 *
 * Tokens for the projects it creates cannot be recovered, so they are written to
 * ~/.muster-tokens.json. That is a home directory rather than anywhere near a
 * checkout on purpose: a token file that lands inside a repository eventually
 * gets committed.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const apply = args.includes('--apply');
const base = (flag('base') ?? 'http://localhost:4600').replace(/\/+$/, '');
const dataDir =
  flag('data') ?? path.join(homedir(), 'projects', 'operator-inbox-app', 'data');
const tokenFile = flag('tokens') ?? path.join(homedir(), '.muster-tokens.json');

const STATUS_MAP = {
  OPEN: 'open',
  ANSWERED: 'answered',
  RESOLVED: 'resolved',
  WONT_DO: 'wont_do',
  IN_PROGRESS: 'in_progress',
};

const PRIORITY_MAP = { low: 'low', normal: 'normal', high: 'high', urgent: 'urgent' };

function parseFile(raw) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const body = match[2];
  const section = (name) => {
    const start = body.indexOf(`## ${name}`);
    if (start === -1) return '';
    const rest = body.slice(start + name.length + 3);
    const end = rest.indexOf('\n## ');
    return (end === -1 ? rest : rest.slice(0, end))
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
  };
  return {
    id: meta.id,
    project: meta.project || 'unsorted',
    agent: meta.agent || 'unknown-agent',
    status: STATUS_MAP[(meta.status || 'OPEN').toUpperCase()] ?? 'open',
    priority: PRIORITY_MAP[(meta.priority || 'normal').toLowerCase()] ?? 'normal',
    question: section('Question'),
    context: section('Context'),
    answer: section('Answer'),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(pathname, options = {}, token = null, attempt = 0) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  // Muster publishes a write limit and answers 429 with retry-after, so an
  // importer that crashes on one is an importer ignoring the contract it was
  // handed. A bulk import is exactly the traffic that hits it.
  if (response.status === 429 && attempt < 20) {
    const wait = Number(response.headers.get('retry-after') ?? body.retry_after ?? 5);
    console.log(`  rate limited, waiting ${wait}s before continuing`);
    await sleep((wait + 1) * 1000);
    return api(pathname, options, token, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${pathname} -> ${response.status} ${text.slice(0, 200)}`);
  }
  return body;
}

const files = (await readdir(dataDir)).filter((name) => name.endsWith('.md'));
const entries = [];
for (const name of files) {
  const parsed = parseFile(await readFile(path.join(dataDir, name), 'utf8'));
  if (parsed?.question) entries.push(parsed);
}

const byProject = new Map();
for (const entry of entries) {
  if (!byProject.has(entry.project)) byProject.set(entry.project, []);
  byProject.get(entry.project).push(entry);
}

console.log(`${entries.length} question(s) across ${byProject.size} project(s) in ${dataDir}`);
for (const [project, list] of byProject) {
  const open = list.filter((entry) => entry.status === 'open').length;
  console.log(`  ${project.padEnd(24)} ${String(list.length).padStart(4)} total, ${open} still open`);
}

if (!apply) {
  console.log('\nDry run. Nothing was written. Pass --apply to import.');
  process.exit(0);
}

const tokens = existsSync(tokenFile) ? JSON.parse(await readFile(tokenFile, 'utf8')) : {};
let incomplete = false;

for (const [project, list] of byProject) {
  if (!tokens[project]) {
    const created = await api('/p', {
      method: 'POST',
      body: JSON.stringify({ name: project }),
    });
    tokens[project] = { project: created.project, token: created.token, read_url: created.read_url };
    await writeFile(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log(`\ncreated ${project} -> ${created.project}  (${created.read_url})`);
  }

  const { project: id, token } = tokens[project];

  // Re-runs are expected: a first pass can stop on a cap, get the project
  // claimed and continue. Questions already there are left alone, and the whole
  // history is paged through rather than the newest page only, or a project
  // past the page size would be imported twice.
  const existing = new Set();
  let cursor = null;
  for (;;) {
    const page = await api(
      `/v1/${id}/escalations?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      {},
      token,
    );
    for (const doc of page.escalations) existing.add(doc.question);
    if (page.escalations.length < 200 || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  let imported = 0;
  let skipped = 0;
  for (const entry of list) {
    const question = entry.question.slice(0, 2000);
    if (existing.has(question)) {
      skipped += 1;
      continue;
    }

    let created;
    try {
      created = await api(
        `/v1/${id}/escalations`,
        {
          method: 'POST',
          body: JSON.stringify({
            agent: entry.agent.slice(0, 48),
            question,
            context: entry.context.slice(0, 8000),
            priority: entry.priority,
          }),
        },
        token,
      );
    } catch (error) {
      if (String(error).includes('limit_reached')) {
        console.log(`  ${project}: hit the unanswered question cap after ${imported}.`);
        console.log('  Answering imported questions frees slots, and claiming the project raises');
        console.log(`  the cap for good:  curl -sX POST ${base}/v1/${id}/claim \\`);
        console.log(`    -H "authorization: Bearer ${token}" -H 'content-type: application/json' \\`);
        console.log("    -d '{\"email\":\"you@example.com\"}'");
        console.log('  Then run this importer again; it continues where it stopped.');
        incomplete = true;
        break;
      }
      throw error;
    }

    if (entry.status !== 'open') {
      await api(
        `/v1/${id}/escalations/${created.escalation.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: entry.status, answer: entry.answer.slice(0, 8000) }),
        },
        token,
      );
    }
    imported += 1;
  }
  console.log(
    `  imported ${imported} into ${project}${skipped > 0 ? `, ${skipped} already there` : ''}`,
  );
}

console.log(`\nTokens are in ${tokenFile}. They are shown once and stored only as hashes on the server.`);
console.log('Claim each project with an email to keep it, then use /operator to see them all at once.');

if (incomplete) {
  // Something else will otherwise treat a half-finished migration as finished.
  console.error('\nAt least one project stopped short of its full history. Exit code 1.');
  process.exit(1);
}
