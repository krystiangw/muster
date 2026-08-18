import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { SERVER_SUMMARY } from '../src/content.js';
import { escapeHtml } from '../src/html.js';
import { authed, createProject, startHarness, type Harness } from './helper.js';

/**
 * The Let Agents In scorecard, as tests.
 *
 * Muster is measured by our own scanner (letagentsin.com), and a marketing
 * claim that nothing checks is a claim that rots. These assertions are the
 * fifteen checks expressed against the app itself, so a regression fails the
 * build instead of the next scan.
 */

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.stop();
});

const AGENT_UAS = ['ChatGPT-User/1.0', 'Claude-User/1.0', 'curl/8.4.0'];

/**
 * The page with the one thing that legitimately differs between two requests
 * taken out: the demo board is drawn from timestamps relative to now, so its
 * `datetime` attributes move by the milliseconds between the two calls. The
 * question being asked here is whether the user agent changes the answer, and
 * a clock is not a user agent.
 */
function withoutTheClock(body: string): string {
  return body.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<when>');
}

describe('A. discovery', () => {
  it('answers a plain request from an agent user agent exactly like a browser', async () => {
    const browser = await harness.server.inject({
      method: 'GET',
      url: '/',
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' },
    });
    assert.equal(browser.statusCode, 200);

    for (const ua of AGENT_UAS) {
      const agent = await harness.server.inject({
        method: 'GET',
        url: '/',
        headers: { 'user-agent': ua },
      });
      assert.equal(agent.statusCode, 200, ua);
      assert.equal(
        withoutTheClock(agent.body),
        withoutTheClock(browser.body),
        `${ua} must not be served different content`,
      );
    }
  });

  it('says what blocked is for, because /next hands back anything still open', async () => {
    // Learned on our own board: four items parked on the operator sat as open
    // with a label, so /next offered them every iteration. The status is the
    // part that stops the work being handed back; a column is only a view.
    const protocol = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.match(protocol.body, /blocked` means waiting on somebody who is not an agent/);
  });

  it('says which calls need an admin token, in the document an agent reads', async () => {
    // Tonight's change made /share admin only, for the same reason /claim is:
    // it is how a project changes hands. An agent holding a worker key that
    // reads "offer this board to a human", calls it and gets a 403 has been
    // told nothing by the document that sent it there.
    const openapi = (
      await harness.server.inject({ method: 'GET', url: '/openapi.json' })
    ).json() as { paths: Record<string, Record<string, { description?: string }>> };
    assert.match(openapi.paths['/v1/{project}/share']!.post!.description!, /admin token/);
    assert.match(openapi.paths['/v1/{project}/claim']!.post!.description!, /admin token/);

    const tools = (
      await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
    ).json().result.tools as Array<{ name: string; description: string }>;
    const share = tools.find((tool) => tool.name === 'share_project')!;
    assert.match(share.description, /admin token/);
  });

  it('tells a client what every tool will do before it runs it', async () => {
    // Several clients auto-approve a read-only tool. So the annotation is not
    // documentation, it is the difference between a tool being run unattended
    // and being shown to somebody first, and the flattering answer is the one
    // that gets a write executed behind the operator's back. Two things are
    // checked: that no tool ships without an answer, and that the answers we
    // would most like to be wrong about are the honest ones.
    const tools = (
      await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
    ).json().result.tools as Array<{
      name: string;
      annotations?: Record<string, boolean>;
    }>;

    for (const tool of tools) {
      assert.ok(tool.annotations, `${tool.name} must say what it does`);
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ]) {
        assert.equal(
          typeof tool.annotations![hint],
          'boolean',
          `${tool.name}.${hint} must be set explicitly, not left to a default`,
        );
      }
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations!]));
    // next_item writes whenever claim is set, and the client cannot see which
    // branch it will get. share_project hands the board away for good and
    // mails somebody. observe closes other people's items.
    for (const name of ['next_item', 'share_project', 'observe', 'upsert_item']) {
      assert.equal(byName.get(name)!.readOnlyHint, false, `${name} writes`);
    }
    assert.equal(byName.get('share_project')!.destructiveHint, true);
    assert.equal(byName.get('observe')!.destructiveHint, true);
    assert.equal(byName.get('escalate')!.openWorldHint, true, 'escalate mails a person');
    assert.equal(byName.get('inbox')!.readOnlyHint, true, 'the inbox touches nothing');

    // The two reads that are not read-only, and the annotation says so rather
    // than rounding it off: both clear leases that have already lapsed. What
    // they must never be is destructive, because that is what a client weighs
    // when it decides whether to run something unattended, and reading a board
    // is the call an agent makes most.
    for (const name of ['list_items', 'board']) {
      assert.equal(byName.get(name)!.readOnlyHint, false, `${name} expires lapsed leases`);
      assert.equal(byName.get(name)!.destructiveHint, false, `${name} must not close work`);
    }
    assert.equal(byName.get('upsert_item')!.destructiveHint, true);
    assert.equal(byName.get('move')!.destructiveHint, true);
    assert.equal(byName.get('register_agent')!.idempotentHint, false);
  });

  it('publishes llms.txt with the entry points in it', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/llms.txt' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /text\/plain/);
    for (const path of ['/skill.md', '/agent-signup.md', '/openapi.json', '/mcp']) {
      assert.match(response.body, new RegExp(path.replace('/', '\\/')), path);
    }
  });

  it('describes itself the same way wherever a catalogue asks', async () => {
    // Three surfaces ask for one line about this server, and `server.json` is
    // published by hand from a laptop, so it is the one that drifts: the
    // registry would then list a sentence nothing on the site says. It also
    // caps the field at a hundred characters, which is the reason the sentence
    // is as short as it is.
    const onDisk = JSON.parse(
      readFileSync(new URL('../../../server.json', import.meta.url), 'utf8'),
    ) as { description: string; name: string; version: string; remotes?: Array<{ url: string }> };
    assert.equal(onDisk.description, SERVER_SUMMARY);
    assert.ok(SERVER_SUMMARY.length <= 100, 'the registry refuses more than a hundred');

    const card = (
      await harness.server.inject({ method: 'GET', url: '/.well-known/mcp.json' })
    ).json() as { description: string; url: string };
    assert.equal(card.description, SERVER_SUMMARY);

    // And the endpoint the registry entry points at is the one this server
    // actually serves, which is the other half of the same drift.
    assert.equal(new URL(onDisk.remotes![0]!.url).pathname, new URL(card.url).pathname);
  });

  it('serves the API reference as a page, from the document that validates the requests', async () => {
    // openapi.json answers "what can I call" only to something willing to
    // parse it. The two readers who will not are a person deciding whether to
    // use this at all, and an agent that fetches HTML and reads it.
    const page = await harness.server.inject({ method: 'GET', url: '/docs/api' });
    assert.equal(page.statusCode, 200);
    const spec = (
      await harness.server.inject({ method: 'GET', url: '/openapi.json' })
    ).json() as { paths: Record<string, Record<string, unknown>> };

    // Generated from the spec rather than written beside it, so this checks
    // the two cannot disagree rather than checking a list somebody typed.
    const paths = Object.keys(spec.paths);
    assert.ok(paths.length >= 10);
    for (const path of paths) {
      assert.ok(page.body.includes(escapeHtml(path)), `${path} is missing from the page`);
    }
    assert.doesNotMatch(page.body, /<script/i);
  });

  it('renders every documentation page without JavaScript', async () => {
    for (const url of ['/', '/docs', '/docs/keys', '/docs/api', '/pricing', '/signup']) {
      const response = await harness.server.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, url);
      assert.doesNotMatch(response.body, /<script/i, `${url} must not need JavaScript`);
      assert.ok(response.body.length > 800, `${url} must carry its content in the first response`);
    }
  });

  it('does not block on-demand agent fetchers and sets no punishing crawl delay', async () => {
    const robots = await harness.server.inject({ method: 'GET', url: '/robots.txt' });
    assert.equal(robots.statusCode, 200);
    assert.match(robots.body, /User-agent: ChatGPT-User\nAllow: \//);
    assert.match(robots.body, /User-agent: Claude-User\nAllow: \//);
    assert.doesNotMatch(robots.body, /Disallow: \/$/m);
    assert.doesNotMatch(robots.body, /Crawl-delay/i);
  });

  it('resolves every path it advertises', async () => {
    const sitemap = await harness.server.inject({ method: 'GET', url: '/sitemap.xml' });
    assert.equal(sitemap.statusCode, 200);
    const paths = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => new URL(match[1]!).pathname,
    );
    assert.ok(paths.length >= 5);
    for (const path of paths) {
      const response = await harness.server.inject({ method: 'GET', url: path || '/' });
      assert.equal(response.statusCode, 200, path);
    }
  });
});

describe('B. agent entry', () => {
  it('serves the entry point under every conventional name', async () => {
    for (const url of ['/skill.md', '/agents.md', '/agent.md', '/agent-signup.md']) {
      const response = await harness.server.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, url);
      assert.match(response.headers['content-type'] as string, /text\/markdown/, url);
      assert.match(response.body, /curl/, `${url} must contain a runnable procedure`);
    }
  });

  it('describes itself as data at the well-known paths', async () => {
    const access = await harness.server.inject({
      method: 'GET',
      url: '/.well-known/agent-access.json',
    });
    assert.equal(access.statusCode, 200);
    const json = access.json();
    assert.equal(json.signup_completable_by_agent, true);
    assert.equal(json.signup.method, 'POST');
    assert.ok(Array.isArray(json.endpoints) && json.endpoints.length >= 8);
    assert.ok(Array.isArray(json.rate_limits) && json.rate_limits.length >= 3);

    const mcp = await harness.server.inject({ method: 'GET', url: '/.well-known/mcp.json' });
    assert.equal(mcp.statusCode, 200);
    assert.equal(mcp.json().transport, 'streamable-http');

    // The AIR catalogue. Adoption is near zero and it is served anyway, on the
    // grounds that it is generated from the same config as everything else and
    // so cannot drift. That last part is what this checks: every entry has to
    // point at something this server actually answers, because a catalogue
    // naming a dead URL is worse than no catalogue at all.
    const catalog = await harness.server.inject({
      method: 'GET',
      url: '/.well-known/ai-catalog.json',
    });
    assert.equal(catalog.statusCode, 200);
    const air = catalog.json() as {
      entries: Array<{ identifier: string; url: string }>;
    };
    assert.ok(air.entries.length >= 2);
    for (const entry of air.entries) {
      assert.match(entry.identifier, /^urn:air:/);
      const reached = await harness.server.inject({
        method: 'GET',
        url: new URL(entry.url).pathname,
      });
      assert.equal(reached.statusCode, 200, entry.url);
    }

    const robots = await harness.server.inject({ method: 'GET', url: '/robots.txt' });
    assert.match(robots.body, /AI-Catalog: \S+\/\.well-known\/ai-catalog\.json/);

    // Three surfaces once told a newcomer to run `npm install @muster/sdk`
    // while the registry answered 404. Both states are checked, because both
    // have a way of going wrong: an advertised package that does not exist, and
    // a published one the protocol forgets to name. The name is read from the
    // card rather than written here, so a rename stays consistent by itself.
    const skill = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    if (json.sdk?.published === true) {
      assert.match(String(json.sdk.npm ?? ''), /^[a-z0-9@._/-]+$/, 'a published sdk is named');
      // The whole token, compared as a set. Asking whether the text contains
      // "npm install muster" is true of a document that installs musterboard,
      // and a card naming one package while the protocol names another is the
      // exact drift this is here to catch.
      const installs = [...skill.body.matchAll(/npm install ([^\n`]+)/g)]
        .flatMap((match) => {
          // Everything up to the first flag. Dropping flags one by one would
          // keep the value of a flag that takes one, so a perfectly good
          // `npm install musterboard --omit dev` would be read as installing
          // something called dev.
          const args = match[1]!.trim().split(/\s+/);
          const firstFlag = args.findIndex((token) => token.startsWith('-'));
          return firstFlag === -1 ? args : args.slice(0, firstFlag);
        })
        .map((token) => token.replace(/[.,;]+$/, ''));
      assert.deepEqual(
        [...new Set(installs)],
        [json.sdk.npm],
        'skill.md installs exactly the package the card publishes, and no other',
      );
    } else {
      assert.equal(json.sdk?.npm, undefined, 'no package name until there is a package');
      assert.ok(!/npm install/.test(skill.body), 'and nothing tells an agent to install one');
    }
  });

  it('supports RFC 7591 dynamic client registration end to end', async () => {
    const metadata = await harness.server.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    assert.equal(metadata.statusCode, 200);
    assert.match(metadata.json().registration_endpoint, /\/oauth\/register$/);

    const registered = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'some-agent', grant_types: ['client_credentials'] },
    });
    assert.equal(registered.statusCode, 201);
    const { client_id, client_secret } = registered.json();
    assert.ok(client_id && client_secret);

    // The secret has no expiry of its own, which is what 0 means, and the date
    // the project is scheduled to go is reported as itself rather than dressed
    // up as a property of the credential.
    assert.equal(registered.json().client_secret_expires_at, 0);
    assert.ok(
      new Date(registered.json().project_expires_at).getTime() > Date.now(),
      'and the project deadline is a real date, in the future',
    );

    // A client that can only do authorization_code is asking for something no
    // deployment of this will ever do, and it should hear that here rather
    // than at the token endpoint.
    const wrongGrant = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'browser-thing', grant_types: ['authorization_code'] },
    });
    assert.equal(wrongGrant.statusCode, 400);
    assert.equal(wrongGrant.json().error, 'invalid_client_metadata');

    // Asking for both is fine: the one it gets is the one it can use.
    const both = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { grant_types: ['authorization_code', 'client_credentials'] },
    });
    assert.equal(both.statusCode, 201);

    // A client whose project is over stops working at the moment it is over,
    // not whenever the TTL monitor next runs, which is a minute or so behind.
    // The project is what decides: the copy of the deadline on the client
    // document is updated separately, and a client whose board was claimed in
    // the meantime must not be locked out by a stale copy.
    const doomed = await harness.server.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'expiring' },
    });
    const dead = doomed.json();
    const tokenFor = async () =>
      harness.server.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: {
          grant_type: 'client_credentials',
          client_id: dead.client_id,
          client_secret: dead.client_secret,
        },
      });

    await harness.store.oauthClients.updateOne(
      { _id: dead.client_id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    assert.equal((await tokenFor()).statusCode, 200, 'a stale copy on the child decides nothing');

    await harness.store.projects.updateOne(
      { _id: dead.project },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const refused = await tokenFor();
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, 'invalid_client');

    const token = await harness.server.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'client_credentials',
        client_id,
        client_secret,
      },
    });
    assert.equal(token.statusCode, 200);
    const access = token.json();
    assert.equal(access.token_type, 'Bearer');

    // The token has to actually work, or the registration is theatre.
    const used = await harness.server.inject({
      method: 'POST',
      url: `/v1/${access.project}/items`,
      headers: { authorization: `Bearer ${access.access_token}` },
      payload: { slug: 'via-oauth', title: 'written with an oauth token', actor: 'some-agent' },
    });
    assert.equal(used.statusCode, 201);
  });

  it('publishes every call an agent needs, including the ones added last', async () => {
    // The card is how an agent discovers this service without reading prose.
    // A call that exists and is not on it is a call nobody finds: the atomic
    // take shipped and the card still described only the look.
    const card = await harness.server.inject({
      method: 'GET',
      url: '/.well-known/agent-access.json',
    });
    // Path and method, without the query string a card entry carries as an
    // example: `{project}` is a placeholder, not something to encode.
    const published = new Set(
      (card.json().endpoints as Array<{ method: string; url: string }>).map((one) => {
        const path = one.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
        return `${one.method} ${path}`;
      }),
    );

    // Derived from the routes rather than from a second hand-kept list, which
    // would fail the same way the card did: the OpenAPI document is generated
    // from what is registered, so it is the inventory. Only the working loop
    // is required to be on the card, because the card is what an agent needs
    // rather than everything this service answers.
    const openapi = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json();
    const working = /^\/v1\/\{project\}\/(items|next|escalations|inbox|observe|agents|board)/;
    const missing: string[] = [];
    for (const [route, methods] of Object.entries(openapi.paths as Record<string, object>)) {
      if (!working.test(route)) continue;
      for (const method of Object.keys(methods)) {
        const call = `${method.toUpperCase()} ${route}`;
        if (!published.has(call)) missing.push(call);
      }
    }
    assert.deepEqual(missing, [], `on the routes and not on the card: ${missing.join(', ')}`);
  });

  it('compresses the public documents, and nothing that holds a credential', async () => {
    const zipped = await harness.server.inject({
      method: 'GET',
      url: '/skill.md',
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal(zipped.headers.vary, 'accept-encoding');
    assert.ok(zipped.rawPayload.length < 12_000, 'and it is actually smaller');

    // A client that does not ask for it still gets readable text, and the Vary
    // header is there either way so a cache cannot serve one to the other.
    const plain = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers.vary, 'accept-encoding');
    assert.match(plain.body, /^# /);

    // The header's own rules, not the word appearing in it. A client that
    // writes gzip;q=0 is saying it cannot read gzip, and it writes the word to
    // say so.
    for (const [header, wanted] of [
      ['gzip;q=0', undefined],
      ['gzip;q=0, br', undefined],
      ['br', undefined],
      ['gzip;q=0.5', 'gzip'],
      ['*', 'gzip'],
      ['br;q=1.0, gzip;q=0.8', 'gzip'],
    ] as const) {
      const answer = await harness.server.inject({
        method: 'GET',
        url: '/skill.md',
        headers: { 'accept-encoding': header },
      });
      assert.equal(answer.headers['content-encoding'], wanted, `accept-encoding: ${header}`);
    }

    // The documentation pages carry the same bytes for everybody too, and they
    // are the four biggest things a person loads here after the landing page.
    for (const page of ['/docs', '/docs/keys', '/pricing', '/signup']) {
      const answer = await harness.server.inject({
        method: 'GET',
        url: page,
        headers: { 'accept-encoding': 'gzip' },
      });
      assert.equal(answer.headers['content-encoding'], 'gzip', page);
    }

    // The allowlist is the point: a page carrying a capability is never
    // compressed, so the length of the answer says nothing about the token in
    // it. This is the read board, reached with the link itself.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const board = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board`,
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(board.statusCode, 200);
    assert.equal(board.headers['content-encoding'], undefined);
  });

  it('every call this service publishes is a call it answers', async () => {
    // The protocol document and the access card are the product's onboarding,
    // and an example that 404s costs an agent the one thing it has: the
    // assumption that the file it is reading is true. The check is deliberately shallow, existence and
    // method rather than semantics, because that is the part that rots when a
    // route is renamed and the prose is not.
    const project = await createProject(harness, 'documented');
    const doc = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.equal(doc.statusCode, 200);

    const calls: Array<{ method: string; url: string; fromCard?: boolean }> = [];
    for (const line of doc.body.split('\n')) {
      if (!line.trimStart().startsWith('curl')) continue;
      // -sX POST, not just -X POST: the flags are written together.
      const method = /-[a-z]*X\s*([A-Z]+)/.exec(line)?.[1] ?? 'GET';
      const token = line
        .split(/\s+/)
        .map((part) => part.replace(/^["']|["'\\]+$/g, ''))
        .find((part) => part.startsWith('$MUSTER') || part.startsWith(harness.config.baseUrl));
      if (!token) continue;
      const url = token
        .replace('$MUSTER', `/v1/${project.id}`)
        .replace(harness.config.baseUrl, '')
        .replace(/<[a-z_]+>/g, 'x')
        .replace(/\$[A-Z_]+/g, 'x');
      calls.push({ method, url });
    }
    assert.ok(calls.length >= 15, `found ${calls.length} documented calls, which is too few to be right`);

    // The machine-readable half of the same promise. It names its methods
    // rather than printing them, so an agent that reads this instead of the
    // prose is trusting exactly the same thing. Where an operation exists on
    // both doors it carries one name, so nobody has to work out that two words
    // describe one act.
    const access = await harness.server.inject({
      method: 'GET',
      url: '/.well-known/agent-access.json',
    });
    const tools = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const toolNames = new Set(
      (tools.json().result.tools as Array<{ name: string }>).map((tool) => tool.name),
    );
    const published = access.json().endpoints as Array<{ name: string; method: string; url: string }>;
    const cardNames = new Set(published.map((endpoint) => endpoint.name));
    const missing = [...toolNames].filter((name) => !cardNames.has(name));
    assert.deepEqual(
      missing,
      [],
      'every MCP tool names an operation the card also publishes; if one genuinely has no HTTP door, say so here rather than letting the names drift',
    );

    for (const endpoint of published) {
      calls.push({
        fromCard: true,
        method: endpoint.method,
        url: endpoint.url
          .replace(harness.config.baseUrl, '')
          .replace('{project}', project.id)
          .replace(/\{[a-z_]+\}/g, 'x'),
      });
    }

    for (const call of calls) {
      const answer = await harness.server.inject({
        method: call.method as 'GET',
        url: call.url,
        headers: authed(project),
        ...(call.method === 'GET' ? {} : { payload: {} }),
      });
      const message = String((answer.json() as { message?: string }).message ?? '');
      assert.ok(
        !message.startsWith('No route for'),
        `${call.method} ${call.url} is published and this server has no such route`,
      );
      // A read the card publishes has to work as printed: something parses
      // that file and calls the URL. The card once advertised the items list
      // with a cursor placeholder in it, which no first read can fill, so
      // following it as given answered bad_cursor. skill.md is prose and may
      // show the second page of a walk, which nobody can call first; and a
      // write is sent here with an empty body on purpose, where being told
      // what is missing is the route working.
      if (call.method === 'GET' && call.fromCard) {
        assert.notEqual(
          answer.statusCode,
          400,
          `${call.url} is published as a read and refuses itself: ${message}`,
        );
      }
    }
  });

  it('answers an MCP handshake differently from a generic POST', async () => {
    const handshake = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      },
    });
    assert.equal(handshake.statusCode, 200);
    assert.equal(handshake.json().result.serverInfo.name, 'muster');

    const generic = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: { hello: 'world' },
    });
    assert.equal(generic.statusCode, 400);
    assert.equal(generic.json().error.code, -32600);
  });
});

describe('C. registration', () => {
  it('has a signup form in the first HTML response, with no CAPTCHA', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/signup' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<form[^>]+method="post"/i);
    assert.match(response.body, /<input[^>]+name="name"/i);
    assert.doesNotMatch(response.body, /captcha|recaptcha|hcaptcha|turnstile/i);
  });

  it('accepts the form submission without a browser', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/signup',
      payload: 'name=headless',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /mk_/, 'the token has to come back in the response');
  });
});

describe('D. provisioning', () => {
  it('documents programmatic credential creation in words a scanner can find', async () => {
    const docs = await harness.server.inject({ method: 'GET', url: '/docs/keys' });
    assert.equal(docs.statusCode, 200);
    const text = docs.body.toLowerCase();
    for (const phrase of [
      'programmatically create',
      'management api',
      'service account',
      'api key',
      'provisioning',
    ]) {
      assert.ok(text.includes(phrase), `/docs/keys must mention "${phrase}"`);
    }
  });

  it('states the free tier in plain text on the pricing page', async () => {
    const pricing = await harness.server.inject({ method: 'GET', url: '/pricing' });
    assert.equal(pricing.statusCode, 200);
    const text = pricing.body.toLowerCase();
    assert.ok(text.includes('free'));
    assert.ok(text.includes('no credit card') || text.includes('needs no card'));
  });
});

describe('E. integration', () => {
  it('publishes an OpenAPI 3.1 description generated from the live schemas', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(response.statusCode, 200);
    const spec = response.json();
    assert.equal(spec.openapi.slice(0, 3), '3.1');
    assert.ok(spec.paths['/p'], 'the signup call must be in the spec');
    assert.ok(spec.paths['/v1/{project}/items'], 'the main write call must be in the spec');
    assert.ok(spec.components.securitySchemes.bearer);
  });
});

describe('the MCP surface', () => {
  it('lists its tools and runs a whole session over JSON-RPC', async () => {
    const list = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const tools = list.json().result.tools as Array<{ name: string }>;
    const names = tools.map((tool) => tool.name);
    for (const expected of ['create_project', 'upsert_item', 'claim_item', 'escalate', 'inbox']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    const created = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_project', arguments: { name: 'over-mcp' } },
      },
    });
    const project = created.json().result.structuredContent;
    assert.match(project.token, /^mk_/);

    const upserted = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${project.token}` },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: { slug: 'from-mcp', title: 'written over MCP', actor: 'mcp-agent' },
        },
      },
    });
    assert.equal(upserted.json().result.structuredContent.created, true);

    const unauthorized = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'upsert_item', arguments: { slug: 'nope' } },
      },
    });
    assert.equal(unauthorized.json().result.isError, true);
  });
});

describe('the human read view', () => {
  it('renders the project without JavaScript and offers the four answer buttons', async () => {
    const created = await harness.server.inject({ method: 'POST', url: '/p', payload: { name: 'viewable' } });
    const { project, token, read_url } = created.json();
    await harness.server.inject({
      method: 'POST',
      url: `/v1/${project}/escalations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { agent: 'a', question: 'Ship it?' },
    });

    const path = new URL(read_url).pathname;
    const view = await harness.server.inject({ method: 'GET', url: path });
    assert.equal(view.statusCode, 200);
    assert.doesNotMatch(view.body, /<script/i);
    assert.match(view.body, /Ship it\?/);
    for (const value of ['answered', 'resolved', 'wont_do', 'in_progress']) {
      assert.match(view.body, new RegExp(`value="${value}"`));
    }
  });
});

describe('keeping the token', () => {
  it('names one place instead of leaving it to the reader', async () => {
    // "Store it wherever you keep your own state" is honest and useless to a
    // session that has no such place: it invents one, and the next session
    // invents a different one and creates a second project for the same work,
    // which the protocol forbids and nothing enforces.
    const protocol = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.match(protocol.body, /~\/\.muster\/tokens\.json/);
    assert.match(protocol.body, /outside every checkout/);
    assert.match(protocol.body, /finds it instead of creating a second project/);
  });
});

describe('the map it hands out', () => {
  it('names paths that answer, rather than only a pattern', async () => {
    const robots = await harness.server.inject({ method: 'GET', url: '/robots.txt' });
    const allowed = [...robots.body.matchAll(/^Allow: (\/.+)$/gm)].map((m) => m[1]!);
    const concrete = allowed.filter((path) => path !== '/');
    assert.ok(concrete.length >= 8, 'a map with no places on it is not a map');

    // Every one of them is a claim, and a claim an agent follows into a 404 is
    // budget it spent on our map being wrong.
    for (const path of concrete) {
      const answer = await harness.server.inject({ method: 'GET', url: path });
      assert.equal(answer.statusCode, 200, `${path} is named in robots.txt`);
    }
  });
});

describe('the source', () => {
  it('is linked from every page, and the site can prove it is ours', async () => {
    const page = await harness.server.inject({ method: 'GET', url: '/' });
    assert.match(page.body, /<a href="https:\/\/github\.com\/krystiangw\/muster">source on GitHub<\/a>/);
    // A board page renders the same footer, so the link is not a landing-page
    // decoration.
    assert.doesNotMatch(page.body, /<meta name="google-site-verification"/);

    const owned = await startHarness({ SITE_VERIFICATION: 'token-from-the-console' });
    try {
      const verified = await owned.server.inject({ method: 'GET', url: '/' });
      assert.match(
        verified.body,
        /<meta name="google-site-verification" content="token-from-the-console">/,
      );
    } finally {
      await owned.stop();
    }
  });
});

describe('the plugin manifest', () => {
  it('is published whole or not at all', async () => {
    // Its schema requires a contact and a logo. A manifest missing a required
    // field is one a strict client throws away, so a deployment with nobody to
    // write to says so with a 404 instead of publishing a broken file.
    const without = await harness.server.inject({ method: 'GET', url: '/.well-known/ai-plugin.json' });
    assert.equal(without.statusCode, 404);
    assert.equal(without.json().error, 'not_configured');

    const reachable = await startHarness({ CONTACT_EMAIL: 'hello@example.com' });
    try {
      const page = await reachable.server.inject({
        method: 'GET',
        url: '/.well-known/ai-plugin.json',
      });
      assert.equal(page.statusCode, 200);
      const manifest = page.json();
      for (const field of [
        'schema_version',
        'name_for_human',
        'name_for_model',
        'description_for_human',
        'description_for_model',
        'auth',
        'api',
        'logo_url',
        'contact_email',
        'legal_info_url',
      ]) {
        assert.ok(manifest[field], `${field} is required by the manifest schema`);
      }
      assert.equal(manifest.contact_email, 'hello@example.com');
      assert.match(manifest.logo_url, /\/apple-touch-icon\.png$/);
    } finally {
      await reachable.stop();
    }
  });
});

describe('the mark', () => {
  it('serves an icon in three shapes, and points every page at them', async () => {
    const page = await harness.server.inject({ method: 'GET', url: '/' });
    assert.match(page.body, /<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml">/);
    assert.match(page.body, /<link rel="icon" href="\/favicon.ico"/);
    assert.match(page.body, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png">/);

    // A browser fetches a favicon under the page's own image policy, so a
    // policy that forgets 'self' leaves every tab blank while the route below
    // answers 200 to anything that asks directly.
    assert.match(
      page.headers['content-security-policy'] as string,
      /img-src 'self' data:/,
    );

    // The stylesheet is a file every page links rather than twenty five
    // kilobytes repeated in every answer. It is named after its own bytes, so
    // it is cached for a year and a deploy that changes it changes the name.
    const sheetHref = page.body.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1];
    assert.match(String(sheetHref), /^\/style-[0-9a-f]{12}\.css$/);
    assert.match(
      page.headers['content-security-policy'] as string,
      /style-src 'self' 'unsafe-inline'/,
      'a sheet the page links is a sheet the policy has to allow',
    );
    const sheet = await harness.server.inject({
      method: 'GET',
      url: String(sheetHref),
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(sheet.statusCode, 200);
    assert.match(sheet.headers['content-type'] as string, /text\/css/);
    assert.match(String(sheet.headers['cache-control']), /immutable/);
    assert.equal(
      sheet.headers['content-encoding'],
      'gzip',
      'and it holds nothing anybody wants, so it may be compressed',
    );
    assert.ok(!page.body.includes('<style>'), 'and it is not in the page as well');

    const svg = await harness.server.inject({ method: 'GET', url: '/favicon.svg' });
    assert.equal(svg.statusCode, 200);
    assert.match(svg.headers['content-type'] as string, /image\/svg\+xml/);
    assert.equal(
      svg.body.match(/<rect/g)?.length,
      4,
      'the tile and its three columns',
    );

    // A favicon.ico that 404s is the single most requested missing file on any
    // site, and it is the one browsers ask for without being told to.
    const ico = await harness.server.inject({ method: 'GET', url: '/favicon.ico' });
    assert.equal(ico.statusCode, 200);
    assert.match(ico.headers['content-type'] as string, /image\/x-icon/);
    const icoBytes = ico.rawPayload;
    assert.deepEqual([...icoBytes.subarray(0, 4)], [0, 0, 1, 0], 'an icon, not a cursor');
    assert.equal(icoBytes.readUInt16LE(4), 3, 'three frames: 16, 32 and 48');
    assert.deepEqual(
      [icoBytes[6], icoBytes[22], icoBytes[38]],
      [16, 32, 48],
      'in that order',
    );

    const png = await harness.server.inject({ method: 'GET', url: '/apple-touch-icon.png' });
    assert.equal(png.statusCode, 200);
    assert.match(png.headers['content-type'] as string, /image\/png/);
    assert.deepEqual(
      [...png.rawPayload.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'a real PNG rather than an empty body with a hopeful header',
    );
    assert.equal(png.rawPayload.readUInt32BE(16), 180, '180 square, which is what iOS wants');
  });
});
