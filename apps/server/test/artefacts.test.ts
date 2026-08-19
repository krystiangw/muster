import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startHarness, type Harness } from './helper.js';

/**
 * The things we publish, checked against the thing we run.
 *
 * Four artefacts describe this service to somebody who has not called it yet:
 * the OpenAPI document, the catalogue at `/.well-known/agent-access.json`, the
 * MCP tool list, and the client on npm. Each is generated or written
 * separately, and each can drift from the service without anything failing.
 * The drift is invisible from inside: every test here passes, production
 * answers correctly, and an agent reading the description goes somewhere that
 * is not there.
 *
 * That is not hypothetical. Today the MCP door was missing a field the HTTP
 * door has taken since the day both existed, and the document a model reads
 * taught one call in a way that sent MCP clients to the losing branch of it.
 * Both were found by comparing these artefacts against each other by hand,
 * which is a thing that happens once and then never again.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('what we publish about ourselves', () => {
  let harness: Harness;
  let openapi: Record<string, any>;
  let catalogue: Record<string, any>;
  let tools: Array<Record<string, any>>;

  before(async () => {
    harness = await startHarness();
    openapi = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json();
    catalogue = (
      await harness.server.inject({ method: 'GET', url: '/.well-known/agent-access.json' })
    ).json();
    const listed = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    let body = listed.body;
    for (const line of body.split('\n')) if (line.startsWith('data: ')) body = line.slice(6);
    tools = JSON.parse(body).result.tools;
    assert.ok(tools.length > 10, `the tool list came back: ${tools.length}`);
  });

  after(async () => {
    await harness.stop();
  });

  /** `{project}`, `${slug}` and `<handle>` all mean the same thing here. */
  const shape = (path: string): string =>
    path
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0]!
      .split('#')[0]!
      .replace(/\$\{[^}]*\}/g, '{x}')
      .replace(/\{[a-zA-Z_]+\}/g, '{x}')
      .replace(/<[^>]+>/g, '{x}')
      .replace(/\/+$/, '') || '/';

  it('sends an agent to addresses that exist', async () => {
    // The catalogue is the map. A renamed route leaves it pointing at nothing,
    // and the agent reading it has no second source to check against.
    const routes = new Set(Object.keys(openapi.paths as object).map(shape));
    const nowhere: string[] = [];
    for (const endpoint of (catalogue.endpoints ?? []) as Array<Record<string, string>>) {
      const url = endpoint.url ?? endpoint.path;
      if (!url) continue;
      if (!routes.has(shape(url))) nowhere.push(`${endpoint.name} -> ${url}`);
    }
    assert.ok((catalogue.endpoints ?? []).length >= 20, 'the catalogue has its entries');
    assert.deepEqual(nowhere, [], `the map names addresses this service does not answer:\n${nowhere.join('\n')}`);
  });

  it('has a client method for every operation the document names', () => {
    // What this guards, exactly: the client's source keeps up with the
    // routes. It does not guard that the version on npm does, because that
    // needs the registry and the suite does not reach the network; the check
    // which installs `musterboard` and drives production through it is
    // `tools/smoke-sdk.mjs`, run by hand. Saying which of the two this is
    // matters, because the drift they catch is not the same drift.
    //
    // By method and path, not by path. Adding a verb to a route the client
    // already touches for another verb is the ordinary way a call becomes
    // unreachable through it, and comparing paths alone cannot see that: the
    // first version of this compared paths and skipped the project root
    // outright, which hid two operations.
    const sdk = readFileSync(`${ROOT}/packages/sdk/src/index.ts`, 'utf8');
    const reachable = new Set(
      [...sdk.matchAll(/this\.request(?:<[^>]*>)?\(\s*'([A-Z]+)',\s*[`']([^`']*)[`']/g)].map(
        (m) => `${m[1]} ${shape(m[2]!)}`,
      ),
    );
    assert.ok(reachable.size >= 20, `the client's calls were read: ${reachable.size}`);

    const missing: string[] = [];
    for (const [path, methods] of Object.entries(openapi.paths as Record<string, object>)) {
      if (!path.startsWith('/v1/{project}')) continue;
      const tail = shape(path.slice('/v1/{project}'.length));
      for (const method of Object.keys(methods)) {
        if (!reachable.has(`${method.toUpperCase()} ${tail}`)) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(missing, [], `the client cannot reach:\n${missing.join('\n')}`);
  });

  it('names only fields its tools have, in the descriptions agents read', () => {
    // A description that mentions an argument the schema does not carry is a
    // description that teaches a call which is refused. The refusal is good;
    // being sent into it is not.
    const ghosts: string[] = [];
    const notFields = new Set(['true', 'false', 'null', 'open', 'done', 'blocked', 'dropped']);
    for (const tool of tools) {
      const fields = new Set(Object.keys((tool.inputSchema?.properties ?? {}) as object));
      // The per field descriptions too, and mostly those: an argument is
      // described where it is declared, so that is where a name for a field
      // this tool does not have gets read. The first version of this looked
      // only at the tool's own sentence and did not notice a `project` added
      // to a property description, which is the exact drift it exists for.
      const properties = Object.values((tool.inputSchema?.properties ?? {}) as Record<string, any>);
      const prose = [
        tool.description ?? '',
        tool.title ?? '',
        ...properties.map((one) => String(one?.description ?? '')),
      ].join(' ');
      for (const named of new Set([...prose.matchAll(/`([a-z_]{2,24})`/g)].map((m) => m[1]!))) {
        if (!fields.has(named) && !notFields.has(named)) ghosts.push(`${tool.name} says \`${named}\``);
      }
    }
    assert.deepEqual(ghosts, [], `tools describing fields they do not have:\n${ghosts.join('\n')}`);
  });

  it('publishes the caps it actually enforces, for both kinds of project', async () => {
    // The numbers on the page are the ones a stranger plans around, and the
    // two kinds are a tenth apart: a board nobody has claimed gets fifty
    // items, not five hundred.
    const created = await harness.server.inject({ method: 'POST', url: '/p', payload: { name: 'fresh' } });
    const project = created.json();
    const summary = await harness.server.inject({
      method: 'GET',
      url: `/v1/${project.project}`,
      headers: { authorization: `Bearer ${project.token}` },
    });
    const enforced = summary.json().limits as Record<string, number>;
    assert.deepEqual(
      enforced,
      catalogue.limits.unclaimed_project
        ? {
            items: catalogue.limits.unclaimed_project.items,
            agents: catalogue.limits.unclaimed_project.agents,
            escalations: catalogue.limits.unclaimed_project.escalations,
          }
        : enforced,
      'an unclaimed board gets what the catalogue says it gets',
    );

    // And the page a person reads carries the same two rows.
    const pricing = (await harness.server.inject({ method: 'GET', url: '/pricing' })).body;
    for (const number of [
      catalogue.limits.unclaimed_project.items,
      catalogue.limits.claimed_project.items,
      catalogue.limits.claimed_project.escalations,
    ]) {
      assert.match(pricing, new RegExp(`\\b${number}\\b`), `the page names ${number}`);
    }
  });
});
