#!/usr/bin/env node
/**
 * The third door, and the one that hands out credentials.
 *
 * A client registers itself under RFC 7591, asks the token endpoint for a token
 * with `client_credentials`, and writes with it. Nothing outside the suite has
 * ever done that against a deployment, and this is the path where a regression
 * costs more than a broken page: it mints keys.
 *
 *   node tools/smoke-oauth.mjs
 *   node tools/smoke-oauth.mjs --base http://127.0.0.1:4600
 *
 * The registration it keeps lives in ~/.muster/smoke.json beside the other
 * two, and is reused, because registering provisions a project and a project is
 * a signup: a check that registers on every run inflates the number the product
 * is judged by.
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
const key = `${base}#oauth`;

let failures = 0;
const step = async (name, run) => {
  try {
    console.log(`ok    ${name} ${(await run()) ?? ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} ${String(error).slice(0, 200)}`);
  }
};

/** Named on every request, so a smoke test is not counted as a newcomer. */
const AS_US = 'muster-selftest smoke-oauth/1.0';

const json = async (url, options = {}) => {
  const response = await fetch(url.startsWith('http') ? url : `${base}${url}`, {
    ...options,
    headers: { 'user-agent': AS_US, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

/**
 * What a client reads before it does anything.
 *
 * Checked before anything is sent, and fatally, not through `step`: everything
 * below posts a client secret to the address this document names, so a failure
 * here has to stop the run rather than be counted and passed over. A document
 * that advertised an endpoint on another host would otherwise have been handed
 * the credentials it asked for.
 */
const stop = (why) => {
  console.log(`FAIL  authorization server metadata ${why}`);
  process.exit(1);
};
const metadata = (await json('/.well-known/oauth-authorization-server')).body;
if (!metadata) stop('is not JSON');
for (const field of ['issuer', 'registration_endpoint', 'token_endpoint', 'grant_types_supported']) {
  if (!metadata[field]) stop(`has no ${field}`);
}
if (!metadata.grant_types_supported.includes('client_credentials')) {
  stop('does not offer client_credentials, which is the only grant this server has');
}
for (const endpoint of [metadata.registration_endpoint, metadata.token_endpoint]) {
  if (!endpoint.startsWith(`${base}/`)) stop(`advertises ${endpoint}, which is not on this deployment`);
}
console.log(`ok    authorization server metadata issuer ${metadata.issuer}, grants ${metadata.grant_types_supported.join(',')}`);

// Everything below goes through the addresses the metadata published, not
// through the ones this file knows. A client follows the document; a check that
// hard codes the paths would pass while every standards-following client fails
// on an endpoint that moved and was advertised wrong.
const REGISTER = metadata.registration_endpoint;
const TOKEN = metadata.token_endpoint;

await step('the resource document points back', async () => {
  const resource = (await json('/.well-known/oauth-protected-resource')).body;
  if (!resource?.authorization_servers?.includes(metadata.issuer)) {
    throw new Error('the resource does not name this authorization server');
  }
  return resource.resource;
});

// Refused metadata, which costs nothing: no project is provisioned for a client
// asking for a grant this server will never run.
await step('refuses a grant it does not have', async () => {
  const refused = await json(REGISTER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'smoke, wrong grant', grant_types: ['authorization_code'] }),
  });
  if (refused.status !== 400) throw new Error(`expected 400, got ${refused.status}`);
  if (refused.body?.error !== 'invalid_client_metadata') throw new Error(JSON.stringify(refused.body).slice(0, 120));
  return refused.body.error;
});

const register = async () => {
  const registered = await json(REGISTER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'oauth smoke test', grant_types: ['client_credentials'] }),
  });
  if (registered.status !== 201 && registered.status !== 200) {
    console.error(`registration answered ${registered.status}: ${JSON.stringify(registered.body).slice(0, 200)}`);
    process.exit(1);
  }
  const fresh = {
    id: registered.body.client_id,
    secret: registered.body.client_secret,
    project: registered.body.project ?? registered.body.scope?.replace('project:', ''),
  };
  mkdirSync(HOME, { recursive: true });
  const all = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  all[key] = fresh;
  writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 });
  return fresh;
};

const ask = (who) =>
  json(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: who.id,
      client_secret: who.secret,
    }).toString(),
  });

// The token endpoint is the liveness probe, because it is the thing under test
// and because it is the only one that can tell a dead registration from a live
// one. Probing with the previous run's token cannot: that token expired an hour
// after it was minted, so it answers 401 whether or not the project still
// exists, and a check reading 401 as "fine" would reuse a dead registration for
// ever while every run failed.
let client = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8'))[key] : null;
let issued = client ? await ask(client) : null;
if (client && issued.status !== 200) {
  // `invalid_client` is the server saying this registration is finished: an
  // unknown client, or a project that expired under it. Anything else, a 429 or
  // a bad minute on the dyno, is the failure this tool is here to report, and
  // registering around it would provision a project for the privilege of hiding
  // it.
  if (issued.body?.error !== 'invalid_client') {
    console.log(`FAIL  client_credentials ${issued.status}: ${JSON.stringify(issued.body).slice(0, 160)}`);
    process.exit(1);
  }
  console.log(`the saved registration is finished (${issued.body.error}), registering again`);
  client = await register();
  issued = await ask(client);
} else if (!client) {
  client = await register();
  issued = await ask(client);
}
console.log(`client ${client.id} on project ${client.project}`);

let token = null;
await step('client_credentials', async () => {
  if (issued.status !== 200) throw new Error(`${issued.status}: ${JSON.stringify(issued.body).slice(0, 160)}`);
  token = issued.body.access_token;
  if (issued.body.token_type !== 'Bearer') throw new Error(`token_type ${issued.body.token_type}`);
  // Short lived, and that is the whole repair this endpoint went through: it
  // used to hand out a key that lived as long as the project, one per refresh.
  if (!(issued.body.expires_in > 0 && issued.body.expires_in <= 3600)) {
    throw new Error(`expires_in ${issued.body.expires_in} is not an hour or less`);
  }
  if (issued.body.scope !== `project:${client.project}`) throw new Error(`scope ${issued.body.scope}`);
  return `expires_in ${issued.body.expires_in}, scope ${issued.body.scope}`;
});

await step('the token writes', async () => {
  const written = await json(`/v1/${client.project}/items`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'smoke:oauth', title: 'work an OAuth client wrote', status: 'done', actor: 'oauth-smoke' }),
  });
  if (written.status >= 400) throw new Error(`${written.status}: ${JSON.stringify(written.body).slice(0, 160)}`);
  return written.body.item.slug;
});

await step('a wrong secret is refused', async () => {
  const refused = await json(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.id,
      client_secret: 'not-the-secret',
    }).toString(),
  });
  if (refused.status !== 401) throw new Error(`expected 401, got ${refused.status}`);
  return refused.body?.error ?? 'refused';
});

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
