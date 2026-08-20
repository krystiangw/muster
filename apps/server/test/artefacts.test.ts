import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { scopeWarningSays } from '../src/types.js';
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

describe('a number this service publishes as a rule', () => {
  /**
   * Written once and read everywhere, checked by looking for it written twice.
   *
   * The lease ceiling was in ten places and the priority scale in nine, four of
   * them prose that nothing compared with the code. They agreed, which is not
   * the same as being unable to disagree: the promise about scope warnings was
   * in three places and had already stopped being true in one of them.
   *
   * Only the source is read, and only for the literals themselves. A test that
   * rendered the pages and looked for the numbers would pass while a second
   * copy sat in the source waiting to be edited on its own.
   */
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sources(`${dir}/${entry.name}`)
        : entry.name.endsWith('.ts')
          ? [`${dir}/${entry.name}`]
          : [],
    );

  it('is written in one place, and nowhere else says it in numbers', () => {
    const written: string[] = [];
    for (const file of sources(`${ROOT}/apps/server/src`)) {
      if (file.endsWith('/types.ts')) continue;
      const text = readFileSync(file, 'utf8');
      const where = file.slice(file.indexOf('/apps/server/') + 13);
      // The ceiling on a lease, and the two ends of the priority scale as a
      // reader meets them: in a schema, in a comparison, or spelled out in a
      // sentence.
      for (const [pattern, name] of [
        [/\b1440\b/, 'CLAIM_TTL_MAX'],
        [/-10 (to|and) 10\b/, 'PRIORITY_SCALE'],
        // A bound is written three ways and review found the third: a schema
        // says `minimum`, a sentence says the range, and a guard says it as a
        // comparison or a clamp. The first version of this test read the first
        // two, so it passed while two files still clamped to the old numbers
        // and would have gone on enforcing them after the constant moved.
        [/minimum: -10/, 'PRIORITY_MIN'],
        [/[<>]=? -10\b|Math\.max\(-10/, 'PRIORITY_MIN'],
        [/[<>]=? 10\b|Math\.min\(10,/, 'PRIORITY_MAX'],
        // Not a bare number: in this codebase 200 is usually a status code, so
        // the pattern names the shapes the page cap is actually written in. The
        // published curl examples are one of them, which review also found: an
        // example asking for more than the schema allows is a document that
        // fails when a reader runs it.
        [/maximum: 200\b/, 'PAGE_MAX'],
        [/at most 200\b/, 'PAGE_MAX'],
        [/limit=200\b/, 'PAGE_MAX'],
      ] as [RegExp, string][]) {
        if (pattern.test(text)) written.push(`${where} spells out ${name}`);
      }
    }
    assert.deepEqual(
      written.sort(),
      [],
      'every one of these is exported from types.ts; import it rather than writing the number again',
    );
  });
});

describe('what a declared scope is said to do', () => {
  /**
   * The same medicine as the numbers above, for a sentence.
   *
   * This promise has now been wrong twice in the same direction. Six documents
   * said a scope warns *other* agents walking into your area, which it has
   * never done. Those were narrowed, and the narrowed sentence was still wider
   * than the code: measured at every door that writes to a card, filing or
   * updating one warns and the other five are silent.
   *
   * Prose cannot be imported the way a number can, so this reads the sources
   * for the phrasings that were wrong, and then reads the rendered artefacts
   * for the one that is right. Absence alone would pass a document that stopped
   * describing scope at all.
   */
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(`${dir}/${entry.name}`)
        : entry.name.endsWith('.ts')
          ? [`${dir}/${entry.name}`]
          : [],
    );

  it('never describes it more widely than the one door that does it', () => {
    const wide: string[] = [];
    const surfaces = [
      ...files(`${ROOT}/apps/server/src`),
      `${ROOT}/packages/sdk/src/index.ts`,
      `${ROOT}/README.md`,
    ];
    for (const file of surfaces) {
      // types.ts is where the sentence lives, the way types.ts is where the
      // numbers live.
      if (file.endsWith('/types.ts')) continue;
      const text = readFileSync(file, 'utf8');
      const where = file.slice(ROOT.length);
      for (const [pattern, why] of [
        [/cross-scope/i, 'calls it a cross-scope write, which reads as the thing it does not do'],
        [
          // The negation is the sentence we want; only the promise is refused.
          /(?<!never )warns? (others|other agents|anyone else|anybody else)/i,
          'says it warns somebody other than the writer',
        ],
        [/when you write outside/i, 'promises every write, and six of the seven doors are silent'],
        [/agent writing outside its declared scope/i, 'names writing rather than the door'],
      ] as [RegExp, string][]) {
        if (pattern.test(text)) wide.push(`${where} ${why}`);
      }
    }
    assert.deepEqual(
      wide.sort(),
      [],
      'scopeWarningSays in types.ts is the sentence; render it rather than describing it again',
    );
  });

  it('says which door it is, everywhere an agent reads before calling', async () => {
    const harness = await startHarness();
    try {
      const said = scopeWarningSays();
      // The sentence itself, because everything below compares a rendered
      // artefact against it: widen this and both sides of that comparison move
      // together, which a mutation of exactly this shape walked through. What
      // stops the code widening past the words is the measurement in
      // api.test.ts; this is the half that stops the words widening past the
      // code.
      assert.match(said, /file or update a card outside/);
      assert.match(said, /never warns anybody else/);
      const openapi = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json();
      const register = openapi.paths['/v1/{project}/agents'].post.description as string;
      assert.ok(register.includes(said), `the OpenAPI description renders it: ${register}`);

      const skill = (await harness.server.inject({ method: 'GET', url: '/skill.md' })).body;
      assert.match(skill, /file or update a card outside/);

      const page = (await harness.server.inject({ method: 'GET', url: '/' })).body;
      assert.match(page, /file or update a card outside/);

      const listed = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      let body = listed.body;
      for (const line of body.split('\n')) if (line.startsWith('data: ')) body = line.slice(6);
      const tool = (JSON.parse(body).result.tools as Array<{ name: string; description: string }>)
        .find((one) => one.name === 'register_agent');
      assert.ok(
        tool?.description.includes(scopeWarningSays('next_item')),
        `the tool description renders it: ${tool?.description}`,
      );
    } finally {
      await harness.stop();
    }
  });
});

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

  it('answers a wrong shape the way the document says, at both doors', async () => {
    // A promise about a refusal, which is the kind this service has been caught
    // making and not keeping. The first version of this sentence promised one
    // code for every door and there are three: the schema in front of HTTP
    // says `invalid_request`, reading a tool's arguments says `bad_argument`,
    // and the block that owns a nested field says `bad_then`. So what is
    // published, and what is checked here, is the part that is true everywhere:
    // a 400 that names the field, and nothing written.
    const doc = (await harness.server.inject({ method: 'GET', url: '/skill.md' })).body;
    assert.match(doc, /a 400 that names the field, and nothing written/, 'the document says what is true');

    const created = await harness.server.inject({ method: 'POST', url: '/p', payload: { name: 'shapes' } });
    const project = created.json() as { project: string; token: string };
    const headers = { authorization: `Bearer ${project.token}`, 'content-type': 'application/json' };
    const crafted = { $ne: null };

    const overHttp = await harness.server.inject({
      method: 'POST',
      url: `/v1/${project.project}/items`,
      headers,
      payload: { slug: 'shaped-http', title: crafted, actor: 'a' },
    });
    assert.equal(overHttp.statusCode, 400, overHttp.body);
    assert.match(overHttp.body, /title/, overHttp.body);

    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'upsert_item', arguments: { slug: 'shaped-mcp', title: crafted, actor: 'a' } },
      },
    });
    const said = String(
      (overMcp.json() as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? '',
    );
    assert.match(said, /^400 /, said);
    assert.match(said, /"title"/, said);

    // The nested one, where a different check owns the field and says so with
    // its own code and the field's full name.
    const nested = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: { slug: 'shaped-then', title: 'fine', actor: 'a', then: { slug: 'next-one', priority: 'high' } },
        },
      },
    });
    const nestedSaid = String(
      (nested.json() as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? '',
    );
    assert.match(nestedSaid, /^400 /, nestedSaid);
    assert.match(nestedSaid, /then\.priority/, nestedSaid);

    // And none of the three wrote anything, which is the other half of it.
    for (const slug of ['shaped-http', 'shaped-mcp', 'shaped-then', 'next-one']) {
      const read = await harness.server.inject({
        method: 'GET',
        url: `/v1/${project.project}/items/${slug}`,
        headers: { authorization: `Bearer ${project.token}` },
      });
      assert.equal(read.statusCode, 404, `${slug} was not made anyway`);
    }
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
