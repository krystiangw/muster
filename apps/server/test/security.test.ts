import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { redactCapabilities } from '../src/app.js';
import { ensureIndexes } from '../src/db.js';
import { hashToken } from '../src/ids.js';
import {
  authed,
  createProject,
  signIn,
  startHarness,
  type Harness,
  type Project,
} from './helper.js';

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

async function claimForEmail(project: Project, email: string): Promise<void> {
  await post(project, '/claim', { email });
  const pending = await harness.store.claimCodes.findOne({ projectId: project.id, email });
  await harness.store.claimCodes.updateOne(
    { _id: pending!._id },
    { $set: { codeHash: hashToken('123456') } },
  );
  await post(project, '/claim/verify', { email, code: '123456' });
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

  it('is reported as a fault rather than answered with a cheerful ok', async () => {
    const isolated = await startHarness({ NODE_ENV: 'production', RESEND_API_KEY: '' });
    try {
      const project = await createProject(isolated);
      const claimed = await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/claim`,
        headers: authed(project),
        payload: { email: 'victim@example.com' },
      });

      // The code reached nobody. Answering ok would send an agent off to wait
      // for something that is never coming.
      assert.equal(claimed.statusCode, 503);
      assert.equal(claimed.json().error, 'mail_not_configured');
      assert.equal(
        await isolated.store.claimCodes.countDocuments({ projectId: project.id }),
        0,
        'and nothing is left pending',
      );

      // Same for the human door, and the answer does not depend on the address,
      // so it stays no kind of account probe.
      const asked = await isolated.server.inject({
        method: 'POST',
        url: '/operator',
        payload: 'email=someone%40example.com',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(asked.statusCode, 503);
      assert.match(asked.body, /cannot send email/i);
    } finally {
      await isolated.stop();
    }
  });
});

describe('a project narrowed to its owner', () => {
  it('stops opening for the link alone, and still opens for the owner', async () => {
    const project = await createProject(harness, 'private');
    const readToken = project.readUrl.split('/r/')[1]!;

    // Open by link is the default, and has to be: an agent creates a project
    // before any person is involved.
    assert.equal(
      (await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` })).statusCode,
      200,
    );

    await claimForEmail(project, 'owner@example.com');
    const closed = await harness.server.inject({
      method: 'PATCH',
      url: project.api,
      headers: authed(project),
      payload: { visibility: 'owner' },
    });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().visibility, 'owner');

    // A stranger holding the link, including one who copied it while the
    // project was open, gets the same page as somebody holding a wrong link.
    const stranger = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.equal(stranger.statusCode, 404);
    const wrongLink = await harness.server.inject({ method: 'GET', url: '/r/r_nosuchtoken/board' });
    assert.equal(stranger.statusCode, wrongLink.statusCode);

    // Writing through the link is what the link is for, so that closes too.
    const moved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/move`,
      payload: 'slug=whatever&column=done',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(moved.statusCode, 404);

    const session = await signIn(harness, 'owner@example.com');
    const mine = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board`,
      headers: { cookie: session.cookie },
    });
    assert.equal(mine.statusCode, 200);

    // Somebody else's session is not a way in either.
    const other = await createProject(harness, 'anchor');
    await claimForEmail(other, 'other@example.com');
    const otherSession = await signIn(harness, 'other@example.com');
    const theirs = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board`,
      headers: { cookie: otherSession.cookie },
    });
    assert.equal(theirs.statusCode, 404);

    // And the agent that works the board never notices any of this.
    const agent = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/board`,
      headers: authed(project),
    });
    assert.equal(agent.statusCode, 200);
  });

  it('refuses to close a project that nobody owns', async () => {
    const project = await createProject(harness, 'ownerless');
    const attempt = await harness.server.inject({
      method: 'PATCH',
      url: project.api,
      headers: authed(project),
      payload: { visibility: 'owner' },
    });
    // Closing it to an owner it does not have would lock out everybody,
    // including the agent that just created it.
    assert.equal(attempt.statusCode, 400);
    assert.equal(attempt.json().error, 'not_claimed');
  });
});

describe('starting up against a database that has already run', () => {
  it('survives an index whose definition changed under it', async () => {
    // Mongo refuses to redefine an index that exists under the same name with
    // different options, and it refuses by throwing, which on the boot path is
    // an instance that never starts. A one word change (a plain index becoming
    // unique) would otherwise take down every deploy after it.
    await harness.store.operatorCodes.dropIndex('email').catch(() => undefined);
    await harness.store.operatorCodes.createIndexes([{ key: { email: 1 }, name: 'email' }]);

    await ensureIndexes(harness.store);

    const indexes = await harness.store.operatorCodes.indexes();
    const email = indexes.find((index) => index.name === 'email');
    assert.equal(email?.unique, true, 'and it ends up with the definition the code asked for');
  });
});
