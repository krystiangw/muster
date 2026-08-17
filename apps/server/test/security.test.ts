import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { redactCapabilities } from '../src/app.js';
import { hashToken } from '../src/ids.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * Regressions for the security audit of 2026-08-17. Each one is a hole that was
 * open on the deployed instance, and every fix below was checked against the
 * request that exploited it.
 */

let harness: Harness;

before(async () => {
  harness = await startHarness({ LIMIT_CLAIM_EMAILS_PER_HOUR: '100' });
});

after(async () => {
  await harness.stop();
});

async function post(project: Project, path: string, payload: unknown, token?: string) {
  return harness.server.inject({
    method: 'POST',
    url: `${project.api}${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : authed(project),
    payload: payload as Record<string, unknown>,
  });
}

describe('ownership is not something a worker key can take', () => {
  it('refuses the claim endpoints to a write key', async () => {
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().token;

    const started = await post(project, '/claim', { email: 'attacker@example.com' }, worker);
    assert.equal(started.statusCode, 403, 'a delegated worker credential cannot bind the tenant');

    const verified = await post(
      project,
      '/claim/verify',
      { email: 'attacker@example.com', code: '123456' },
      worker,
    );
    assert.equal(verified.statusCode, 403);

    assert.equal(await harness.store.claimCodes.countDocuments({ projectId: project.id }), 0);
  });

  it('refuses a pending code that outlived somebody else taking the project', async () => {
    const project = await createProject(harness);
    const plant = async (email: string) => {
      await post(project, '/claim', { email });
      const pending = await harness.store.claimCodes.findOne({ projectId: project.id, email });
      await harness.store.claimCodes.updateOne(
        { _id: pending!._id },
        { $set: { codeHash: hashToken('123456') } },
      );
    };

    // Both claims start while the project is unowned, which is allowed: it has
    // no owner to protect yet.
    await plant('attacker@example.com');
    await plant('first@example.com');

    // Redeemed at the same instant, so both get past the "is it owned yet"
    // check and the ownership write itself is the only thing standing between
    // them. It used to be an unguarded $set, which meant the later one simply
    // took a project the earlier one had just been given.
    const [one, two] = await Promise.all([
      post(project, '/claim/verify', { email: 'first@example.com', code: '123456' }),
      post(project, '/claim/verify', { email: 'attacker@example.com', code: '123456' }),
    ]);

    const won = [one, two].filter((response) => response.statusCode === 200);
    assert.equal(won.length, 1, 'exactly one of them owns it');

    const doc = await harness.store.projects.findOne({ _id: project.id });
    assert.ok(['first@example.com', 'attacker@example.com'].includes(doc!.claimedBy!));
    assert.equal(
      (won[0]!.json() as { project: { claimed_by?: string } }).project.claimed_by ??
        doc!.claimedBy,
      doc!.claimedBy,
      'and the answer matches what was stored',
    );
  });

  it('refuses to start a claim on a project that already has an owner', async () => {
    const project = await createProject(harness);
    await post(project, '/claim', { email: 'first@example.com' });
    const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );
    await post(project, '/claim/verify', { email: 'first@example.com', code: '123456' });

    const second = await post(project, '/claim', { email: 'attacker@example.com' });
    assert.equal(second.json().already_claimed_by, 'first@example.com');
    assert.equal(
      await harness.store.claimCodes.countDocuments({ projectId: project.id }),
      0,
      'and no code is sent that could be redeemed later',
    );
  });
});

describe('one request is one request', () => {
  it('refuses an MCP batch big enough to be an amplifier', async () => {
    const project = await createProject(harness);
    const batch = Array.from({ length: 200 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'list_items', arguments: {} },
    }));

    const response = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: batch,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /at most 25/);
  });

  it('charges every tool call against the published limit, not every HTTP request', async () => {
    const isolated = await startHarness({ LIMIT_WRITES_PER_MINUTE: '3' });
    try {
      const project = await createProject(isolated);
      const call = (index: number) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: {
          name: 'upsert_item',
          arguments: { slug: `batched-${index}`, title: 'x', actor: 'a' },
        },
      });

      const response = await isolated.server.inject({
        method: 'POST',
        url: '/mcp',
        headers: authed(project),
        payload: [call(1), call(2), call(3), call(4), call(5)],
      });
      const results = response.json() as Array<{ result?: { isError?: boolean } }>;
      const refused = results.filter((entry) => entry.result?.isError).length;
      assert.ok(refused >= 2, `a batch past the limit is refused per call, refused=${refused}`);

      // And the writes that were refused did not land.
      assert.ok((await isolated.store.items.countDocuments({ projectId: project.id })) <= 3);
    } finally {
      await isolated.stop();
    }
  });
});

describe('what the service tells a stranger about its users', () => {
  it('does not confirm whether an address is one of them', async () => {
    const anchor = await createProject(harness, 'anchor');
    await post(anchor, '/claim', { email: 'real@example.com' });
    const pending = await harness.store.claimCodes.findOne({ projectId: anchor.id });
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );
    await post(anchor, '/claim/verify', { email: 'real@example.com', code: '123456' });

    const known = await post(await createProject(harness, 'a'), '/share', {
      email: 'real@example.com',
      agent: 'probe',
    });
    const unknown = await post(await createProject(harness, 'b'), '/share', {
      email: 'never-seen@example.com',
      agent: 'probe',
    });

    assert.equal(known.statusCode, unknown.statusCode);
    assert.equal(known.json().hint, unknown.json().hint);
    assert.deepEqual(Object.keys(known.json()).sort(), Object.keys(unknown.json()).sort());
  });
});

describe('capability links', () => {
  it('never reach the log with their token intact', () => {
    assert.equal(
      redactCapabilities('/r/r_894fh39x02kvay11/board?agent=errors-loop'),
      '/r/[redacted]/board?agent=errors-loop',
    );
    assert.equal(
      redactCapabilities('/operator/mk_live_token/shares/s_1'),
      '/operator/[redacted]/shares/s_1',
    );
    assert.equal(redactCapabilities('/v1/p_public/items'), '/v1/p_public/items');
  });

  it('can be replaced when one leaks', async () => {
    const project = await createProject(harness);
    const before = project.readUrl.split('/r/')[1]!;

    const rotated = await post(project, '/read-link/rotate', {});
    assert.equal(rotated.statusCode, 200);
    const after = (rotated.json().read_url as string).split('/r/')[1]!;
    assert.notEqual(after, before);

    const old = await harness.server.inject({ method: 'GET', url: `/r/${before}/board` });
    assert.equal(old.statusCode, 404, 'the leaked link is dead');
    const fresh = await harness.server.inject({ method: 'GET', url: `/r/${after}/board` });
    assert.equal(fresh.statusCode, 200);
  });

  it('needs an admin key to rotate', async () => {
    const project = await createProject(harness);
    const worker = (await post(project, '/keys', { name: 'worker', role: 'write' })).json().token;
    const attempt = await post(project, '/read-link/rotate', {}, worker);
    assert.equal(attempt.statusCode, 403);
  });
});

describe('the response headers', () => {
  it('carry a policy that suits a page with no scripts at all', async () => {
    const page = await harness.server.inject({ method: 'GET', url: '/docs' });
    const csp = page.headers['content-security-policy'] as string;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/, 'those pages carry one click forms');
    assert.ok(!csp.includes('script-src'), 'nothing may execute, so nothing is allowed to');
    assert.equal(page.headers['referrer-policy'], 'no-referrer', 'the token lives in the path');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
  });

  it('keep a capability page out of shared caches', async () => {
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.headers['cache-control'] as string, /no-store/);
  });
});

describe('an email that cannot be sent', () => {
  it('is discarded rather than written to the log in production', async () => {
    const lines: string[] = [];
    const isolated = await startHarness({ NODE_ENV: 'production', RESEND_API_KEY: '' });
    try {
      isolated.server.log.info = ((message: unknown) => {
        lines.push(typeof message === 'string' ? message : JSON.stringify(message));
      }) as typeof isolated.server.log.info;

      const project = await createProject(isolated);
      await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/claim`,
        headers: authed(project),
        payload: { email: 'victim@example.com' },
      });

      const printed = lines.join('\n');
      assert.ok(!/\b\d{6}\b/.test(printed), 'the six digit code is not in the log');
      assert.ok(!printed.includes('victim@example.com'), 'nor the whole address');
    } finally {
      await isolated.stop();
    }
  });
});
