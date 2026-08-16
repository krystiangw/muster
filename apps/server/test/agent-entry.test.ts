import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startHarness, type Harness } from './helper.js';

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
      assert.equal(agent.body, browser.body, `${ua} must not be served different content`);
    }
  });

  it('publishes llms.txt with the entry points in it', async () => {
    const response = await harness.server.inject({ method: 'GET', url: '/llms.txt' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /text\/plain/);
    for (const path of ['/skill.md', '/agent-signup.md', '/openapi.json', '/mcp']) {
      assert.match(response.body, new RegExp(path.replace('/', '\\/')), path);
    }
  });

  it('renders every documentation page without JavaScript', async () => {
    for (const url of ['/', '/docs', '/docs/keys', '/pricing', '/signup']) {
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
