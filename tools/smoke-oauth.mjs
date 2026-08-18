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
const STATE = join(homedir(), '.muster', 'smoke.json');
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

const json = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

// What a client reads before it does anything, and the only description of this
// server it is entitled to trust.
const metadata = (await json('/.well-known/oauth-authorization-server')).body;
await step('authorization server metadata', async () => {
  for (const field of ['issuer', 'registration_endpoint', 'token_endpoint', 'grant_types_supported']) {
    if (!metadata?.[field]) throw new Error(`no ${field}`);
  }
  if (!metadata.grant_types_supported.includes('client_credentials')) {
    throw new Error('client_credentials is not offered, which is the only grant this server has');
  }
  for (const endpoint of [metadata.registration_endpoint, metadata.token_endpoint]) {
    if (!endpoint.startsWith(base)) throw new Error(`${endpoint} is not on this deployment`);
  }
  return `issuer ${metadata.issuer}, grants ${metadata.grant_types_supported.join(',')}`;
});

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
  const refused = await json('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'smoke, wrong grant', grant_types: ['authorization_code'] }),
  });
  if (refused.status !== 400) throw new Error(`expected 400, got ${refused.status}`);
  if (refused.body?.error !== 'invalid_client_metadata') throw new Error(JSON.stringify(refused.body).slice(0, 120));
  return refused.body.error;
});

const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8'))[key] : null;
let client = saved;
if (client) {
  const alive = await json(`/v1/${client.project}`, { headers: { authorization: `Bearer ${client.probe ?? ''}` } });
  // 401 is the ordinary state here: the probe token from last run expired an
  // hour after it was minted, which is the point of this endpoint.
  if (alive.status === 404) {
    console.log('the registered project is gone, registering again');
    client = null;
  }
}
if (!client) {
  const registered = await json('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'oauth smoke test', grant_types: ['client_credentials'] }),
  });
  if (registered.status !== 201 && registered.status !== 200) {
    console.error(`registration answered ${registered.status}: ${JSON.stringify(registered.body).slice(0, 200)}`);
    process.exit(1);
  }
  client = {
    id: registered.body.client_id,
    secret: registered.body.client_secret,
    project: registered.body.project ?? registered.body.scope?.replace('project:', ''),
  };
  mkdirSync(join(homedir(), '.muster'), { recursive: true });
  const all = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  all[key] = client;
  writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 });
}
console.log(`client ${client.id} on project ${client.project}`);

let token = null;
await step('client_credentials', async () => {
  const issued = await json('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: client.id,
      client_secret: client.secret,
    }).toString(),
  });
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
  const refused = await json('/oauth/token', {
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

// Kept for the next run, so the probe above can tell "the project expired" from
// "the token expired", which are different failures.
const all = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
all[key] = { ...client, probe: token };
writeFileSync(STATE, JSON.stringify(all, null, 1), { mode: 0o600 });

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
