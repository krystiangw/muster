import assert from 'node:assert/strict';
import { OAUTH_TOKEN_IS } from '../src/routes/oauth.js';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { SERVER_SUMMARY } from '../src/content.js';
import { escapeHtml, setContactEmail } from '../src/html.js';
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

  it('marks every call that needs an admin token as needing one', async () => {
    // A worker key is the key an agent is told to mint for itself, and two
    // calls in the published catalogue said nothing about needing more than
    // one: an agent following the document got a 403 the document had not
    // prepared it for. The routes are the source of truth here, not a list.
    const access = (
      await harness.server.inject({ method: 'GET', url: '/.well-known/agent-access.json' })
    ).json() as { endpoints: Array<{ name: string; auth?: string }> };
    const byName = new Map(access.endpoints.map((entry) => [entry.name, entry]));
    for (const name of ['share_project', 'delete_item']) {
      assert.equal(byName.get(name)?.auth, 'admin token', `${name} needs the admin token`);
    }
  });

  it('refuses a stream where it has none, so a client does not reconnect for ever', async () => {
    // Measured against production with the official SDK: a client sitting
    // completely idle opened a standalone GET about once a second, because a
    // 200 where the protocol says 405 reads as a stream that closed. Eighty
    // thousand requests a day, per idle client, doing nothing.
    const asSdk = await harness.server.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(asSdk.statusCode, 405);
    assert.equal(asSdk.headers.allow, 'POST');

    // And a person who pasted the URL into a browser still gets told what this
    // endpoint is, which is why the card was there in the first place.
    const asPerson = await harness.server.inject({ method: 'GET', url: '/mcp' });
    assert.equal(asPerson.statusCode, 200);
    assert.match(asPerson.json().usage, /POST/);
  });

  it('answers a body it cannot parse with a 400, not with "we broke"', async () => {
    // 5xx is the one class this protocol tells an agent to retry, so a
    // permanently malformed request became a loop, and every typo landed in
    // our log as an unhandled error.
    for (const payload of ["{'name':'x'}", '{"name":}', '']) {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/p',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      assert.equal(answer.statusCode, 400, JSON.stringify(payload));
      assert.equal(answer.json().error, 'bad_json');
      assert.doesNotMatch(answer.json().message, /our side/);
    }
  });

  it('does not argue about a header when the route asked for nothing', async () => {
    // Measured, not assumed: every route here takes no body at all, and each
    // one answered 400 "The body was empty" to a client that sets the header
    // once for every call. Two of them are how a leaked credential is taken
    // back, and that is not the moment to be told to send `{}`.
    const project = await createProject(harness);
    const key = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/keys`,
      headers: authed(project),
      payload: { name: 'spare', role: 'write' },
    });
    const item = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'a-thing-to-remove', title: 'a thing to remove', actor: 'someone' },
    });
    const json = { ...authed(project), 'content-type': 'application/json' };

    for (const [method, url] of [
      ['POST', `${project.api}/read-link/rotate`],
      ['POST', `${project.api}/sweep`],
      ['DELETE', `${project.api}/keys/${key.json().key.id}`],
      ['DELETE', `${project.api}/items/a-thing-to-remove`],
    ] as Array<['POST' | 'DELETE', string]>) {
      const answer = await harness.server.inject({ method, url, headers: json });
      assert.equal(answer.statusCode, 200, `${method} ${url}: ${answer.body.slice(0, 120)}`);
    }
  });

  it('still says so when a route that wants a body is sent none', async () => {
    // The other half of the rule above, and the list that made the first
    // attempt at it wrong. Reading "no body schema" as "no body" looks right
    // and is not: every route here declares none and reads one anyway, so an
    // empty body stopped being a sentence about the empty body and became, in
    // turn, a garbled error, an OAuth complaint about a grant type nobody
    // sent, and a signup page answered 200 to a form with nothing in it.
    for (const url of ['/p', '/mcp', '/signup', '/oauth/register', '/oauth/token']) {
      const answer = await harness.server.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      assert.equal(answer.statusCode, 400, url);
      assert.equal(answer.json().error, 'bad_json', url);
    }
  });

  it('answers the handshake with a version it speaks, not with the one it was sent', async () => {
    // It used to echo, so a client asking for 1999-01-01 was told yes: we
    // claimed every revision that exists and several that do not, and a client
    // relying on the one it named would find out by misbehaving.
    const ask = async (protocolVersion: string) =>
      (
        await harness.server.inject({
          method: 'POST',
          url: '/mcp',
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion, capabilities: {} },
          },
        })
      ).json().result.protocolVersion as string;

    assert.equal(await ask('2025-06-18'), '2025-06-18', 'one we speak is answered as asked');
    assert.equal(await ask('2025-03-26'), '2025-03-26', 'including an older one');
    // Not this one: its transport is a long-lived SSE stream this route does
    // not serve, so confirming it would be the same lie in a smaller font.
    assert.equal(await ask('2024-11-05'), '2025-06-18');
    const invented = await ask('1999-01-01');
    assert.notEqual(invented, '1999-01-01');
    assert.equal(invented, '2025-06-18', 'and anything else gets the newest we have');
  });

  it('says how a token reaches an MCP client, which cannot mint one mid-session', async () => {
    // create_project needs no auth and hands back a token, but a client sends
    // its headers when the session opens, so the session that made the token
    // cannot use it. Nothing said so anywhere, which made the advertised
    // signup look broken from inside an MCP client.
    const signup = (await harness.server.inject({ method: 'GET', url: '/agent-signup.md' })).body;
    assert.match(signup, /mcpServers/);
    assert.match(signup, /authorization": "Bearer/);

    const made = (
      await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_project', arguments: { name: 'through mcp' } },
        },
      })
    ).json();
    const answer = JSON.parse(made.result.content[0].text) as Record<string, unknown>;
    // The same facts the HTTP door hands back, so an agent that came in this
    // way knows its caps and what to do next.
    for (const field of ['project', 'token', 'api', 'read_url', 'board_url', 'limits', 'next']) {
      assert.ok(field in answer, `create_project answers with ${field}`);
    }
    // And it says what is true of this endpoint rather than a rule about MCP:
    // the header is read per request, so a caller that can set one is done.
    assert.match(String(answer.how_to_use_this_token), /per request/);
  });

  it('lists every admin-only call the routes actually have', async () => {
    // Written out by hand twice and wrong twice: first claiming a worker key
    // makes every other call, then leaving one out. So the list is not
    // written out here either. The routes are read, every one that calls
    // `requireAdmin` is collected, and the protocol has to name it: adding an
    // admin-only route without documenting it fails this.
    const source = readFileSync(new URL('../src/routes/api.ts', import.meta.url), 'utf8');
    const routes = [...source.matchAll(/scoped\.(get|post|put|patch|delete)\(\s*\n\s*'([^']+)'/g)];
    const adminOnly: Array<{ method: string; path: string }> = [];
    routes.forEach((route, index) => {
      const from = route.index ?? 0;
      const to = routes[index + 1]?.index ?? source.length;
      if (source.slice(from, to).includes('requireAdmin(request)')) {
        adminOnly.push({ method: route[1]!.toUpperCase(), path: route[2]! });
      }
    });
    assert.ok(adminOnly.length >= 12, 'the routes were read, not guessed');

    const protocol = (await harness.server.inject({ method: 'GET', url: '/skill.md' })).body;
    const named = protocol.slice(protocol.indexOf('The whole admin-only list'));
    for (const { path } of adminOnly) {
      // The tail of the path is what the document writes, since it writes them
      // relative to $MUSTER. Items are the exception the sentence itself
      // makes: an ordinary upsert is not admin, one carrying `history` is.
      const bare = path.replace('/v1/:project', '');
      // The document names a parameter the way that reads, and the routes name
      // it the way Fastify wants, so both spellings count.
      const tails = ['<slug>', '<id>', '<handle>'].map((placeholder) =>
        bare.replace(/:slug|:id|:handle/g, placeholder),
      );
      const written =
        tails.some((tail) => named.includes(tail)) ||
        (bare === '/items' && named.includes('history')) ||
        (bare.startsWith('/keys') && named.includes('everything under')) ||
        (bare === '' && named.includes('the project itself'));
      assert.ok(written, `${path} needs an admin token, so the protocol has to say so`);
    }
  });

  it('refuses those calls to a worker key, which is what the list is about', async () => {
    const project = await createProject(harness);
    const worker = (
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/keys`,
        headers: authed(project),
        payload: { name: 'worker', role: 'write' },
      })
    ).json() as { token: string };
    const asWorker = { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json' };

    const calls: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['PATCH', `${project.api}/rules`, { claim_ttl_minutes: 30 }],
      ['PUT', `${project.api}/board`, { columns: [{ key: 'a', title: 'A', match: {} }] }],
      ['POST', `${project.api}/read-link/rotate`, {}],
      ['POST', `${project.api}/share`, { email: 'nobody@example.com' }],
      ['POST', `${project.api}/keys`, { name: 'another', role: 'write' }],
      ['PATCH', project.api, { name: 'renamed' }],
    ];
    for (const [method, url, payload] of calls) {
      const refused = await harness.server.inject({
        method: method as 'PATCH',
        url,
        headers: asWorker,
        ...(payload ? { payload } : {}),
      });
      assert.equal(refused.statusCode, 403, `${method} ${url} is admin only`);
    }
  });

  it('keeps a body that is too large from reading as a syntax error', async () => {
    // The parser's failures are one thing and every other client error is
    // another. Rounding them together told a caller whose body was a megabyte
    // of perfectly good JSON to go looking for a missing quote.
    const answer = await harness.server.inject({
      method: 'POST',
      url: '/p',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', description: 'y'.repeat(2_000_000) }),
    });
    assert.equal(answer.statusCode, 413);
    assert.notEqual(answer.json().error, 'bad_json');
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

  it('puts the address a person writes to on the pages a person reads', async () => {
    // It was published in the agent files and nowhere else, so the machines
    // were told who to write to and the people were not.
    //
    // The negative first, and the address put back afterwards: the footer
    // reads it from a module the whole process shares, like the verification
    // token beside it, so a harness built with one would otherwise leave it
    // behind for every test after this.
    const quiet = await harness.server.inject({ method: 'GET', url: '/' });
    assert.doesNotMatch(quiet.body, /mailto:/, 'a deployment with nobody to write to says nothing');

    const reachable = await startHarness({ CONTACT_EMAIL: 'hello@muster.test' });
    try {
      for (const url of ['/', '/docs', '/pricing']) {
        const page = await reachable.server.inject({ method: 'GET', url });
        assert.match(page.body, /mailto:hello@muster\.test/, url);
      }
    } finally {
      await reachable.stop();
      setContactEmail('');
    }
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

  it('advertises every page it links to', async () => {
    // The other direction, which is the one that drifts. The list of pages in
    // the sitemap is written out by hand, and the router already knows: two
    // pages had to be linked from the footer before anything following links
    // could find them, and the sitemap is the same fact in a second place. A
    // page nobody advertises is a page only somebody already on the site can
    // reach.
    const sitemap = await harness.server.inject({ method: 'GET', url: '/sitemap.xml' });
    const advertised = new Set(
      [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!).pathname),
    );

    // Follow what the pages themselves link, which is what a crawler does.
    const found = new Set<string>(['/']);
    const queue = ['/'];
    const pages = new Set<string>();
    while (queue.length > 0) {
      const path = queue.shift()!;
      const rendered = await harness.server.inject({
        method: 'GET',
        url: path,
        headers: { accept: 'text/html' },
      });
      if (rendered.statusCode !== 200) continue;
      // Only what a person is meant to read and a crawler is meant to keep:
      // the markdown and the json this service serves are for agents and are
      // named in llms.txt instead, and a capability link is deliberately not
      // advertised anywhere.
      if (!String(rendered.headers['content-type'] ?? '').startsWith('text/html')) continue;
      pages.add(path);
      // Every internal link, then the path out of it. Matching a path that
      // carries no query and no fragment would skip a page linked only as
      // "/guide#start", and skipping it is exactly the case this is for.
      for (const [, href] of rendered.body.matchAll(/href="(\/[^"]*)"/g)) {
        const { pathname } = new URL(href!, 'https://board.invalid');
        const next = pathname.replace(/\/$/, '') || '/';
        if (found.has(next) || next.startsWith('/r/') || next.startsWith('/style-')) continue;
        found.add(next);
        queue.push(next);
      }
    }

    assert.ok(pages.size >= 5, `crawled ${pages.size} pages`);
    for (const page of pages) {
      assert.ok(advertised.has(page), `${page} is a page this site links to but does not advertise`);
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
    // The catalogue is reachable and allowed, and it is named where naming it
    // is valid: the head link on every page. It used to be named here too,
    // with an `AI-Catalog:` directive that exists in no standard, and a parser
    // reading an unknown directive calls the whole file invalid. Every line of
    // this file is one a crawler is known to read.
    assert.match(robots.body, /Allow: \/\.well-known\/ai-catalog\.json/);
    assert.match(robots.body, /Sitemap: \S+\/sitemap\.xml/);
    for (const line of robots.body.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      assert.match(
        trimmed,
        /^(User-agent|Allow|Disallow|Sitemap|Crawl-delay):/,
        `robots.txt directive nobody defined: ${trimmed}`,
      );
    }

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

    // What that token is, measured, because the page and the document now say
    // it out loud. It was published as "a project token", which is true and
    // silent about the half somebody wiring this into a shared context needs:
    // it is an admin key, so it mints further keys and deletes cards.
    const minted = await harness.server.inject({
      method: 'POST',
      url: `/v1/${access.project}/keys`,
      headers: { authorization: `Bearer ${access.access_token}`, 'content-type': 'application/json' },
      payload: { name: 'a key made with an oauth token', role: 'admin' },
    });
    assert.equal(minted.statusCode, 201, 'the token is an admin one, and the page says so');
    const deleted = await harness.server.inject({
      method: 'DELETE',
      url: `/v1/${access.project}/items/via-oauth`,
      headers: { authorization: `Bearer ${access.access_token}` },
    });
    assert.equal(deleted.statusCode, 200);

    // And on nobody else's board, which is the other half of the sentence.
    const elsewhere = await createProject(harness);
    for (const [what, sent] of [
      ['read', await harness.server.inject({
        method: 'GET',
        url: `/v1/${elsewhere.id}/board`,
        headers: { authorization: `Bearer ${access.access_token}` },
      })],
      ['write', await harness.server.inject({
        method: 'POST',
        url: `/v1/${elsewhere.id}/items`,
        headers: { authorization: `Bearer ${access.access_token}`, 'content-type': 'application/json' },
        payload: { slug: 'not-yours', title: 'not yours', actor: 'a' },
      })],
    ] as Array<[string, { statusCode: number }]>) {
      assert.equal(sent.statusCode, 403, `the token was refused on another board, ${what}`);
    }

    // The hour, from the constant the sentence is built from rather than from
    // a number written twice.
    assert.ok(
      Math.abs(access.expires_in - 3600) <= 2,
      `the token said it lasts ${access.expires_in} seconds`,
    );
    assert.match(OAUTH_TOKEN_IS, /admin key/);
    assert.match(OAUTH_TOKEN_IS, /up to 60 minutes/);

    // The hour is a ceiling, not a promise: a key never outlives the board it
    // is for. Said as a flat sixty minutes, the sentence was wrong for every
    // unclaimed project in its last hour, which is the shape this service
    // hands out by default.
    await harness.store.projects.updateOne(
      { _id: access.project },
      { $set: { expiresAt: new Date(Date.now() + 10 * 60_000) } },
    );
    const shortened = await harness.server.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'client_credentials', client_id, client_secret },
    });
    assert.equal(shortened.statusCode, 200);
    assert.ok(
      shortened.json().expires_in <= 600,
      `a board with ten minutes left handed out ${shortened.json().expires_in} seconds`,
    );
    assert.match(OAUTH_TOKEN_IS, /expires_in/);
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

    // Measured against the same document rather than against a number, which
    // is what this line used to be: a literal set just above whatever the file
    // weighed the day it was written. It read as a compression check and
    // behaved as an accidental ceiling, and it failed on a day the compression
    // was working perfectly and three paragraphs had been added.
    const plainForRatio = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.ok(
      zipped.rawPayload.length < plainForRatio.rawPayload.length / 2,
      `gzip carried ${zipped.rawPayload.length} of ${plainForRatio.rawPayload.length} bytes`,
    );

    // The ceiling kept, on purpose and with the reason written down: every
    // agent that connects loads this document whole, so its length is a cost
    // paid on every session rather than a number in a test. Crossing it is a
    // signal to cut something, not to raise it. Roughly ten thousand tokens,
    // and it sat at thirty-three thousand bytes the day the budget was named.
    assert.ok(
      plainForRatio.rawPayload.length < 40_000,
      `skill.md is ${plainForRatio.rawPayload.length} bytes: cut something rather than raising this`,
    );

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
    // One name per operation, in both directions. The card advertised
    // heartbeat_claim and release_claim, and adding the tools of the same name
    // put a second row on each URL: a client picking operations by name read
    // one call as two. The names are what a caller matches on, so a duplicate
    // is worse than a gap.
    const seen = new Map<string, string[]>();
    for (const endpoint of published) {
      const key = `${endpoint.method} ${endpoint.url}`;
      seen.set(key, [...(seen.get(key) ?? []), endpoint.name]);
    }
    const twice = [...seen.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([key, names]) => `${key} is published as ${names.join(' and ')}`);
    assert.deepEqual(twice, [], 'one operation, one name');

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

  it('hands over the token with the same warning either way', async () => {
    // The two doors mint the same one-time secret, and only one of them said
    // so. An agent that discards it has lost the project: there is no second
    // copy, because only a hash is stored. The HTTP door already warned about
    // this when minting a worker key, so the one caller nobody warned was the
    // one holding the token that owns everything.
    const { TOKEN_IS_SHOWN_ONCE } = await import('../src/content.js');

    const overHttp = await harness.server.inject({
      method: 'POST',
      url: '/p',
      payload: { name: 'either-way' },
    });
    assert.equal(overHttp.statusCode, 201);
    assert.equal(overHttp.json().notice, TOKEN_IS_SHOWN_ONCE);

    const overMcp = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_project', arguments: { name: 'either-way-too' } },
      },
    });
    assert.equal(overMcp.json().result.structuredContent.notice, TOKEN_IS_SHOWN_ONCE);
  });

  it('carries a claim from start to finish, which it could not before', async () => {
    // claim_item told a client that "claims expire without a heartbeat" on a
    // door with no heartbeat and no release, so an MCP agent could take a lease
    // and then only wait for it to lapse: it could neither hold it through long
    // work nor hand it back early. The instructions on that door say the tools
    // mirror skill.md, and skill.md documents both.
    let id = 100;
    const call = async (name: string, args: Record<string, unknown>, token?: string) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        payload: { jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } },
      });
      return answer.json().result;
    };

    const project = (await call('create_project', { name: 'lifecycle' })).structuredContent;
    const token = project.token as string;
    await call('upsert_item', { slug: 'ops:cutover', title: 'Cut traffic over', actor: 'mcp-agent' }, token);

    const claimed = await call('claim_item', { slug: 'ops:cutover', agent: 'mcp-agent' }, token);
    assert.equal(claimed.structuredContent.ok, true);
    const first = Date.parse(claimed.structuredContent.expires_at);

    const beat = await call(
      'heartbeat',
      { slug: 'ops:cutover', agent: 'mcp-agent', ttl_minutes: 120 },
      token,
    );
    assert.equal(beat.structuredContent.ok, true);
    assert.ok(Date.parse(beat.structuredContent.expires_at) > first, 'the lease moved out');

    // Somebody else holding it is still a refusal, on this door as on the other.
    const stranger = await call('heartbeat', { slug: 'ops:cutover', agent: 'other-loop' }, token);
    assert.equal(stranger.isError, true);

    const handedBack = await call(
      'release',
      { slug: 'ops:cutover', agent: 'mcp-agent', note: 'needs the venue first' },
      token,
    );
    assert.equal(handedBack.structuredContent.ok, true);
    assert.equal(handedBack.structuredContent.item.claim, null);

    // And it is free at once rather than at the sweep: the point of releasing.
    const offered = await call('next_item', { agent: 'other-loop' }, token);
    assert.equal(offered.structuredContent.item.slug, 'ops:cutover');
  });

  it('drains the inbox it hands out, rather than repeating it for ever', async () => {
    // inbox returns answers nobody has acted on. Without acknowledge on this
    // door there was no way to say you had, so the same answer came back every
    // iteration and two agents could act on one decision without either
    // knowing.
    let id = 200;
    const call = async (name: string, args: Record<string, unknown>, token?: string) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        payload: { jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } },
      });
      return answer.json().result;
    };

    const project = (await call('create_project', { name: 'inbox-drain' })).structuredContent;
    const token = project.token as string;
    const asked = await call('escalate', { question: 'Bridge it or wait?', agent: 'mcp-agent' }, token);
    const question = asked.structuredContent.escalation.id as string;

    // The operator's half, which has no tool on this door and should not.
    const { answerEscalation } = await import('../src/service.js');
    await answerEscalation(harness.store, project.project, question, 'answered', 'bridge it', 'http');

    const waiting = await call('inbox', { agent: 'mcp-agent' }, token);
    assert.equal(waiting.structuredContent.answers.length, 1);

    const acked = await call(
      'acknowledge',
      { id: question, agent: 'mcp-agent', note: 'bridged it' },
      token,
    );
    assert.equal(acked.structuredContent.escalation.acted_by, 'mcp-agent');

    const drained = await call('inbox', { agent: 'mcp-agent' }, token);
    assert.equal(drained.structuredContent.answers.length, 0);

    // Two agents acting on one decision is the case this refuses by name.
    const second = await call('acknowledge', { id: question, agent: 'other-loop' }, token);
    assert.equal(second.isError, true);
  });

  it('will not acknowledge on behalf of nobody', async () => {
    // Every other tool falls back to the session's handle when the argument is
    // missing, and every other tool either fails or no-ops if that handle is
    // wrong. This one consumes the answer for everybody: acknowledged as
    // "unknown-agent" it is gone from the intended agent's inbox for good, and
    // the refusal that exists to stop two agents acting on one decision then
    // fires on the agent that should have had it.
    let id = 300;
    const call = async (name: string, args: Record<string, unknown>, token?: string) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        payload: { jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } },
      });
      return answer.json().result;
    };
    const project = (await call('create_project', { name: 'no-handle' })).structuredContent;
    const token = project.token as string;
    const asked = await call('escalate', { question: 'Bridge it?', agent: 'mcp-agent' }, token);
    const question = asked.structuredContent.escalation.id as string;
    const { answerEscalation } = await import('../src/service.js');
    await answerEscalation(harness.store, project.project, question, 'answered', 'bridge it', 'http');

    const nameless = await call('acknowledge', { id: question }, token);
    assert.equal(nameless.isError, true);
    assert.match(JSON.stringify(nameless), /agent/);

    // And the answer is still there for whoever was meant to act on it.
    const still = await call('inbox', { agent: 'mcp-agent' }, token);
    assert.equal(still.structuredContent.answers.length, 1);
  });

  it('says an argument is the wrong type, rather than guessing what it meant', async () => {
    // MCP arguments are whatever a model produced, so a wrong type is likelier
    // here than anywhere. Five of the six tools that take a slug read it
    // leniently: `{"slug": 42}` became "" and the caller was told its slug had
    // no alphanumeric characters, which is true of "" and not of 42. The slug
    // is what selects the card, so being wrong about why it was refused costs
    // an agent the one retry it might have got right.
    const project = await createProject(harness, 'wrong types');
    let id = 400;
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${project.token}` },
        payload: { jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } },
      });
      return answer.json().result;
    };

    // Each tool gets the arguments it actually declares. One bag for all four
    // was refused for naming a field two of them do not have, which is the
    // guard below doing its job on the test rather than on the code.
    const bags: Record<string, Record<string, unknown>> = {
      upsert_item: { slug: 42 },
      heartbeat: { slug: 42, agent: 'a' },
      release: { slug: 42, agent: 'a' },
      move: { slug: 42, column: 'doing' },
    };
    for (const [name, args] of Object.entries(bags)) {
      const wrong = await call(name, args);
      assert.equal(wrong.isError, true, name);
      assert.match(
        String(wrong.content[0].text),
        /"slug" is a string here/,
        `${name} said: ${String(wrong.content[0].text)}`,
      );
    }

    // And absence is its own answer, not an empty slug.
    const missing = await call('append_note', { message: 'something happened' });
    assert.equal(missing.isError, true);
    assert.match(String(missing.content[0].text), /"slug" is required here/);
  });

  it('teaches the one call on both doors in the document a model actually reads', async () => {
    // The catalogue already answers this for anybody who reads the catalogue.
    // skill.md is the document a model reads before it does anything, and it
    // taught the call as `POST $MUSTER/next` and nowhere mentioned the MCP
    // spelling or the flag. A client arriving over MCP and following it landed
    // on the branch the same page calls the losing one, and nothing in the
    // page said so.
    const skill = (await harness.server.inject({ method: 'GET', url: '/skill.md' })).body;
    assert.match(skill, /next_item/, 'the MCP name for it is in the document');
    assert.match(skill, /"claim": true/, 'and so is the flag that makes it the take');
    // And that the flagless call is the look, not a broken take.
    assert.match(skill, /GET \/next/, 'beside the HTTP call that does the same thing');
  });

  it('lets both doors write what both doors hand back', async () => {
    // `meta` has been on the HTTP door since the day both doors existed, the
    // published client sends it, and the read side returns it on every agent
    // whichever door asks. The MCP schema never got it, so an agent could be
    // handed a field it had no way to set.
    const project = await createProject(harness, 'both doors');
    const registered = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...authed(project), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'register_agent',
          arguments: { handle: 'through-mcp', meta: { runs: 'on the night shift' } },
        },
      },
    });
    assert.notEqual(registered.json().result?.isError, true, registered.body);

    const read = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/agents`,
      headers: authed(project),
    });
    const agent = read.json().agents.find((one: { handle: string }) => one.handle === 'through-mcp');
    assert.deepEqual(agent?.meta, { runs: 'on the night shift' }, 'what one door wrote, the other reads');

    // And a model that sends the wrong shape is told, rather than answered
    // 200 over an empty field. This door refuses what it cannot keep
    // everywhere else; the first version of this one quietly dropped it.
    const wrong = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...authed(project), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'register_agent', arguments: { handle: 'shapes', meta: 'on the night shift' } },
      },
    });
    assert.equal(wrong.json().result?.isError, true, wrong.body);
    assert.match(JSON.stringify(wrong.json().result.content), /is an object here/);
    assert.equal(
      await harness.store.agents.countDocuments({ projectId: project.id, handle: 'shapes' }),
      0,
      'and nothing was registered under a refusal',
    );
  });

  it('says where the one call named on only one door lives on the other', async () => {
    // Every MCP tool already has to name an operation the catalogue publishes,
    // which the check further down enforces. The gap this leaves is the other
    // way: `take_next_item` is a name in the catalogue and not a tool, because
    // over MCP it is `next_item` with a flag. An agent that read the catalogue
    // and went looking for it found nothing and had no way to learn why.
    const catalogue = (
      await harness.server.inject({ method: 'GET', url: '/.well-known/agent-access.json' })
    ).json() as { endpoints: { name: string; notes?: string }[] };
    const takeNext = catalogue.endpoints.find((endpoint) => endpoint.name === 'take_next_item');
    assert.ok(takeNext, 'the catalogue still has the call this is about');
    assert.match(String(takeNext!.notes), /next_item with "claim": true/);
  });

  it('can read the history the lists only count', async () => {
    // Every list on this door hands back `timeline_count` and never the
    // entries, so a client could see that four things had happened to a card
    // and had no call that would tell it what. The timeline is where this
    // product keeps the why, and the other door has always had it.
    const project = await createProject(harness, 'the why');
    let id = 700;
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${project.token}` },
        payload: { jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params: { name, arguments: args } },
      });
      return answer.json().result;
    };

    const listing = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${project.token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const listedTools = listing.json().result.tools as { name: string; description: string }[];

    await call('upsert_item', { slug: 'ops:why', title: 'a card with a history', actor: 'first' });
    await call('append_note', { slug: 'ops:why', message: 'the venue answered on the second try', actor: 'first' });

    await call('upsert_item', { slug: 'build:pager', title: 'a card in another area', actor: 'first' });

    // Both doors answer alike, which is the whole reason this read lives in the
    // service: the namespace filter arrived on the HTTP door first, and the
    // pair before it had already drifted apart twice.
    const narrowed = await call('list_items', { prefix: 'ops:' });
    assert.deepEqual(
      narrowed.structuredContent.items.map((item: { slug: string }) => item.slug),
      ['ops:why'],
    );
    const viaHttp = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items?prefix=ops:`,
      headers: { authorization: `Bearer ${project.token}` },
    });
    assert.deepEqual(
      viaHttp.json().items.map((item: { slug: string }) => item.slug),
      narrowed.structuredContent.items.map((item: { slug: string }) => item.slug),
    );

    // And this door can find out what the namespaces are, which until now it
    // could not: the facets were on the HTTP door only.
    const facets = await call('board_facets', {});
    assert.deepEqual(facets.structuredContent.prefixes, ['build:', 'ops:']);

    const listed = await call('list_items', { q: 'ops:why' });
    const fromList = listed.structuredContent.items[0];
    assert.ok(fromList.timeline_count >= 2, 'the list counts them');
    assert.equal(fromList.timeline, undefined, 'and does not carry them');

    const read = await call('read_item', { slug: 'ops:why' });
    assert.equal(read.isError, undefined);
    const item = read.structuredContent.item;
    assert.equal(item.slug, 'ops:why');
    // Up to fifty: the timeline keeps a window and `timeline_count` keeps
    // counting, so on a long-running card the two differ and the description
    // says which one is the total.
    assert.equal(item.timeline.length, Math.min(fromList.timeline_count, 50));
    assert.ok(
      item.timeline.some((entry: { message?: string }) =>
        String(entry.message ?? '').includes('the venue answered on the second try'),
      ),
      'and the words somebody actually wrote',
    );

    // A slug nobody filed is refused rather than answered with an empty card.
    const missing = await call('read_item', { slug: 'ops:never-filed' });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.code, 'not_found');

    // Past the window the entries stop and the count does not, which is what
    // the description now says rather than promising every one of them.
    for (let n = 0; n < 55; n += 1) {
      await call('append_note', { slug: 'ops:why', message: `note ${n}`, actor: 'first' });
    }
    const long = await call('read_item', { slug: 'ops:why' });
    const kept = long.structuredContent.item;
    assert.equal(kept.timeline.length, 50, 'the window');
    assert.ok(kept.timeline_count > 50, 'and the count past it');
    assert.match(
      (listedTools.find((tool: { name: string }) => tool.name === 'read_item') as { description: string })
        .description,
      /last fifty entries are kept, and timeline_count is the true total/,
      'and the tool says so before anybody finds out',
    );
  });

  it('says an argument arrived beside the envelope rather than inside it', async () => {
    // `{"name":"list_items","limit":1,"arguments":{...}}` answered 200 with
    // fifty items while the caller believed it had asked for one. The word was
    // right and the layer was wrong, and nothing said so: the same silence the
    // HTTP door was built to refuse, on the door that never got the guard.
    const project = await createProject(harness, 'the wrong layer');
    let id = 900;
    const send = async (params: Record<string, unknown>) => {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${project.token}` },
        payload: { jsonrpc: '2.0', id: (id += 1), method: 'tools/call', params },
      });
      return answer.json().result;
    };

    const outside = await send({ name: 'list_items', limit: 1, arguments: { status: 'open' } });
    assert.equal(outside.isError, true);
    assert.equal(outside.structuredContent.code, 'misplaced_argument');
    assert.match(String(outside.content[0].text), /"limit" is an argument of "list_items"/);
    assert.match(String(outside.content[0].text), /Move it into params\.arguments/);

    // Inside the envelope, the same call works, which is what makes the
    // sentence above worth printing.
    const inside = await send({ name: 'list_items', arguments: { limit: 1, status: 'open' } });
    assert.equal(inside.isError, undefined);

    // An argument no tool has is not silently dropped either, which is what
    // the other door has always done with the same word in a body.
    const invented = await send({
      name: 'list_items',
      arguments: { zupelnie_wymyslony: 'tak' },
    });
    assert.equal(invented.isError, true);
    assert.equal(invented.structuredContent.code, 'unknown_argument');
    assert.match(
      String(invented.content[0].text),
      /"zupelnie_wymyslony" is not a field "list_items" has\./,
    );
    assert.match(String(invented.content[0].text), /It takes status, owner, label/);

    // What tools/list advertises and what this door does have to be the same
    // sentence. An open schema tells a client generating arguments from the
    // listing that anything goes, and then the call is refused: the contract
    // said yes and the door said no, which is worse than either answer alone.
    const listed = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${project.token}` },
      payload: { jsonrpc: '2.0', id: 999, method: 'tools/list' },
    });
    for (const tool of listed.json().result.tools) {
      assert.equal(
        tool.inputSchema.additionalProperties,
        false,
        `${tool.name} advertises the same closed shape this door enforces`,
      );
    }

    // `_meta` is the protocol's, not ours. A client sending a progress token
    // beside the arguments is conforming, not guessing, and params is the one
    // object here we do not own.
    const meta = await send({
      name: 'list_items',
      arguments: { limit: 1 },
      _meta: { progressToken: 'abc' },
    });
    assert.equal(meta.isError, undefined);

    // And a key that is neither the protocol's nor the tool's is left alone
    // for the same reason: there is no second place it could have meant.
    const foreign = await send({
      name: 'list_items',
      arguments: { limit: 1 },
      whateverTheClientAdded: true,
    });
    assert.equal(foreign.isError, undefined);
  });

  it('says the store is unreachable in the same words the other door uses', async () => {
    // A client branches on the code. Told "internal" it cannot tell a bug it
    // should report from an outage it should wait out, and this door was
    // giving both the same one while the HTTP door had just learned to
    // separate them.
    const project = await createProject(harness, 'store-down');
    const { MongoServerSelectionError } = await import('mongodb');
    const real = harness.store.items.find.bind(harness.store.items);
    harness.store.items.find = (() => {
      throw new MongoServerSelectionError('no primary reachable', new Map() as never);
    }) as typeof harness.store.items.find;
    try {
      const answer = await harness.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${project.token}` },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_items', arguments: {} },
        },
      });
      const result = answer.json().result;
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.code, 'store_unavailable');
      assert.equal(result.structuredContent.status, 503);
      // The same sentence, not merely a similar one: two copies of it drifting
      // is how a client branching on the code ends up reading one answer here
      // and another over there.
      const { STORE_UNAVAILABLE } = await import('../src/content.js');
      assert.equal(result.structuredContent.error, STORE_UNAVAILABLE);
      // The delay too: a batch is many calls in one response, and the header
      // the HTTP door sets cannot say which of them should wait.
      assert.equal(result.structuredContent.retry_after, 5);
    } finally {
      harness.store.items.find = real;
    }
  });

  it('charges a tool that writes against the write budget', async () => {
    // The two budgets are published apart and a batch is many calls in one
    // request, so this door counts per call. Which bucket was a set of names
    // kept beside the tools: heartbeat, release and acknowledge all write, and
    // all three were charged as reads on the day they were added, at five
    // times the writes an agent is allowed.
    const strict = await startHarness({ LIMIT_WRITES_PER_MINUTE: '1', LIMIT_READS_PER_MINUTE: '500' });
    try {
      const project = await createProject(strict, 'budgets');
      const call = async (name: string, args: Record<string, unknown>) =>
        strict.server.inject({
          method: 'POST',
          url: '/mcp',
          headers: { authorization: `Bearer ${project.token}` },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
        });

      // One write is allowed, and it is the claim's own setup.
      await call('upsert_item', { slug: 'ops:cutover', title: 'Cut traffic over', actor: 'a' });
      for (const [name, args] of [
        ['heartbeat', { slug: 'ops:cutover', agent: 'a' }],
        ['release', { slug: 'ops:cutover', agent: 'a' }],
        ['acknowledge', { id: 'e_nothing', agent: 'a' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const answer = await call(name, args);
        assert.match(
          JSON.stringify(answer.json()),
          /rate_limited/,
          `${name} was not charged as a write: ${answer.body.slice(0, 200)}`,
        );
      }

      // And a read still goes through on its own budget.
      const read = await call('board', {});
      assert.doesNotMatch(JSON.stringify(read.json()), /rate_limited/);
    } finally {
      await strict.stop();
    }
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
