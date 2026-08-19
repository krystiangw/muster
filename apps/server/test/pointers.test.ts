import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * Every address an answer hands out is an address this service has.
 *
 * The documents are checked elsewhere. This is the other half: the URLs the
 * API itself prints into its replies. A 404 says the map is at `/llms.txt`, a
 * refused body points at `/openapi.json`, a signup hands back four links and
 * tells the caller how to keep the project, and an escalation replies with the
 * page a person is meant to open. An agent that has just been refused is
 * exactly the reader least able to work out that the address it was given does
 * not exist, so a stale one here costs more than a stale one in prose.
 *
 * Matched against the router rather than fetched, because most of these are
 * written to be posted to: this service answers a GET on a POST-only path with
 * the same 404 it gives a path it does not have, so fetching would report the
 * management API as missing.
 */
let harness: Harness;
let project: Project;

before(async () => {
  harness = await startHarness(
    // Set, because the plugin manifest is the one answer that refuses to
    // publish without a contact address, and it carries two pointers of its
    // own: the logo a directory renders and the page it links for terms.
    { CONTACT_EMAIL: 'hello@muster.test' },
    {
      mailer: {
        sendClaimCode: async () => 'sent',
        sendOperatorCode: async () => 'sent',
        sendBoardOffer: async () => 'sent',
        sendQuietBoard: async () => 'sent',
        sendEscalation: async () => 'sent',
      },
    },
  );
  project = await createProject(harness, 'pointers');
});

after(async () => {
  await harness.stop();
});

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** True when some method of this service answers that path. */
function routed(path: string): boolean {
  const router = harness.server as unknown as {
    findRoute: (input: { method: string; url: string }) => unknown;
  };
  return METHODS.some((method) => Boolean(router.findRoute({ method, url: path })));
}

describe('every address these answers hand out', () => {
  it('is a route this service has', async () => {
    const headers = authed(project);
    const said: string[] = [];
    // The expected status is part of each call, because a scenario that
    // quietly starts failing would otherwise contribute its error body instead
    // of its answer, and take its pointers out of the sweep without saying so.
    const collect = async (
      call: {
        method: 'GET' | 'POST';
        url: string;
        headers?: Record<string, string>;
        payload?: Record<string, unknown>;
      },
      expected: number,
    ): Promise<void> => {
      const answer = await harness.server.inject({
        method: call.method,
        url: call.url,
        ...(call.headers ? { headers: call.headers } : {}),
        ...(call.payload ? { payload: call.payload } : {}),
      });
      assert.equal(
        answer.statusCode,
        expected,
        `${call.method} ${call.url}: ${answer.body.slice(0, 200)}`,
      );
      said.push(answer.body);
    };

    // A signup that names an owner, which is the reply carrying the most
    // links: the API, the read view, the board, the protocol, and the two
    // calls that decide whether the project survives.
    await collect(
      {
        method: 'POST',
        url: '/p',
        payload: { name: 'pointers', owner_email: 'human@example.com', agent: 'errors-loop' },
      },
      201,
    );
    await collect(
      { method: 'POST', url: `${project.api}/agents`, headers, payload: { handle: 'errors-loop' } },
      201,
    );
    await collect(
      {
        method: 'POST',
        url: `${project.api}/items`,
        headers,
        payload: { slug: 'ops:cutover', title: 'Cut traffic over' },
      },
      201,
    );
    await collect(
      {
        method: 'POST',
        url: `${project.api}/escalations`,
        headers,
        payload: { question: 'Bridge it or wait?', item_slug: 'ops:cutover' },
      },
      201,
    );
    await collect({ method: 'GET', url: `${project.api}/inbox`, headers }, 200);
    await collect(
      { method: 'POST', url: `${project.api}/share`, headers, payload: { email: 'human@example.com' } },
      201,
    );
    await collect(
      { method: 'POST', url: `${project.api}/claim`, headers, payload: { email: 'human@example.com' } },
      200,
    );
    // The two refusals that exist to send somebody somewhere else.
    await collect({ method: 'GET', url: '/v1/no-such-project/items' }, 401);
    await collect({ method: 'GET', url: '/there-is-nothing-here' }, 404);
    await collect(
      { method: 'POST', url: `${project.api}/items`, headers, payload: { slog: 'typo' } },
      400,
    );
    // What a client reads before it starts, and what it is handed mid-session.
    for (const url of [
      '/.well-known/agent-access.json',
      '/.well-known/mcp.json',
      '/.well-known/ai-catalog.json',
      '/.well-known/ai-plugin.json',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/openapi.json',
    ]) {
      await collect({ method: 'GET', url }, 200);
    }
    await collect(
      {
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        },
      },
      200,
    );

    // Parsed rather than matched: the base URL is a string with a dot in it,
    // and a regex built from it accepts http://muster-test as our own host.
    const ours = new URL(harness.config.baseUrl).origin;
    const paths = new Set<string>();
    for (const body of said) {
      for (const [candidate] of body.matchAll(/https?:\/\/[^\s"'\\)]+/g)) {
        // Trailing punctuation from a sentence that ends on an address.
        let here: URL;
        try {
          here = new URL(candidate.replace(/[.,;:]+$/, ''));
        } catch {
          continue;
        }
        if (here.origin === ours) paths.add(here.pathname + here.search);
      }
    }
    assert.ok(paths.size >= 40, `the answers hand out addresses: found ${paths.size}`);

    const missing = [...paths].filter((path) => !routed(path));
    assert.deepEqual(missing, [], `handed out, but nothing answers there:\n  ${missing.join('\n  ')}`);
  });

});
