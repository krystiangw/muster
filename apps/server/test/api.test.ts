import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness.stop();
});

async function post(project: Project, path: string, payload: unknown) {
  return harness.server.inject({
    method: 'POST',
    url: `${project.api}${path}`,
    headers: authed(project),
    payload: payload as Record<string, unknown>,
  });
}

async function get(project: Project, path: string) {
  return harness.server.inject({
    method: 'GET',
    url: `${project.api}${path}`,
    headers: authed(project),
  });
}

describe('signup', () => {
  it('creates a project, a token and a read url in one unauthenticated call', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/p',
      payload: { name: 'fleet' },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.match(body.project, /^p_/);
    assert.match(body.token, /^mk_/);
    assert.match(body.read_url, /\/r\/r_/);
    assert.ok(body.expires_at, 'an unclaimed project must carry an expiry');
  });

  it('rejects an unknown token', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/v1/p_nope/agents',
      headers: { authorization: 'Bearer mk_wrong' },
    });
    assert.equal(response.statusCode, 401);
  });

  it('rejects a token from another project', async () => {
    const a = await createProject(harness, 'a');
    const b = await createProject(harness, 'b');
    const response = await harness.server.inject({
      method: 'GET',
      url: `${b.api}/agents`,
      headers: authed(a),
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('items', () => {
  it('is idempotent on slug: two writes converge on one item', async () => {
    const project = await createProject(harness);
    const first = await post(project, '/items', {
      slug: 'errors:withdraw-stuck',
      title: 'Withdraw stuck',
      body: 'first pass',
      actor: 'errors-loop',
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().created, true);

    const second = await post(project, '/items', {
      slug: 'errors:withdraw-stuck',
      body: 'second pass',
      note: 'found the cause',
      actor: 'other-loop',
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);

    const list = await get(project, '/items');
    assert.equal(list.json().items.length, 1);

    const item = await get(project, '/items/errors:withdraw-stuck');
    const timeline = item.json().item.timeline;
    assert.equal(item.json().item.body, 'second pass');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[1].message, 'found the cause');
  });

  it('normalises a slug rather than inventing a second identity', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'Errors: Withdraw Stuck', title: 'x', actor: 'a' });
    const again = await post(project, '/items', { slug: 'errors:-withdraw-stuck', title: 'x', actor: 'a' });
    assert.equal(again.json().created, false);
  });

  it('warns when an open item already carries the same title', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'a-one', title: 'Venue A withdraw stuck', actor: 'a' });
    const twin = await post(project, '/items', {
      slug: 'b-two',
      title: 'venue-a withdraw stuck',
      actor: 'b',
    });
    const warnings = twin.json().warnings as string[];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /a-one/);
  });

  it('says which end of the priority scale is urgent, everywhere it is offered', async () => {
    // The author of this system used the scale backwards for four hours,
    // because nothing said which way it ran and getting it wrong is silent:
    // /next keeps answering, it just answers with the wrong work.
    const protocol = await harness.server.inject({ method: 'GET', url: '/skill.md' });
    assert.match(protocol.body, /higher means more urgent/i);

    const openapi = await harness.server.inject({ method: 'GET', url: '/openapi.json' });
    const schema = JSON.stringify(openapi.json());
    assert.match(schema, /Higher is more urgent/);

    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const board = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(board.body, /Higher is more urgent/);

    // And the behaviour the sentence promises.
    await post(project, '/items', { slug: 'small', title: 'small', priority: 1, actor: 'a' });
    await post(project, '/items', { slug: 'urgent', title: 'urgent', priority: 9, actor: 'a' });
    await post(project, '/agents', { handle: 'a', scope: [] });
    const next = await get(project, '/next?agent=a');
    assert.equal(next.json().item.slug, 'urgent', 'the larger number goes first');
  });

  it('records a status transition in the timeline', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'x', title: 'x', actor: 'a' });
    await post(project, '/items', { slug: 'x', status: 'done', note: 'shipped', actor: 'a' });
    const item = (await get(project, '/items/x')).json().item;
    assert.equal(item.status, 'done');
    assert.ok(item.closed_at);
    assert.equal(item.timeline.at(-1).kind, 'status');
    assert.match(item.timeline.at(-1).message, /open -> done: shipped/);
  });

  it('converges when ten agents file the same new slug at once', async () => {
    const project = await createProject(harness);
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(project, '/items', {
          slug: 'errors:same-problem',
          title: 'the same problem',
          actor: `agent-${i}`,
          note: `from agent ${i}`,
        }),
      ),
    );

    assert.equal(responses.filter((r) => r.statusCode >= 400).length, 0, 'nobody gets an error');
    assert.equal(
      responses.filter((r) => r.json().created === true).length,
      1,
      'exactly one writer is told it created the item',
    );

    const list = await get(project, '/items');
    assert.equal(list.json().items.length, 1, 'one slug, one item');

    const item = await get(project, '/items/errors:same-problem');
    assert.equal(item.json().item.timeline.length, 10, 'every writer is in the timeline');
  });

  it('carries history over from another system with its own timestamps, for admins only', async () => {
    const project = await createProject(harness);
    const response = await post(project, '/items', {
      slug: 'migrated',
      title: 'came from the old board',
      actor: 'migration',
      history: [
        { at: '2026-04-16T20:16:55.485Z', by: 'audit-sync', message: 'first sighting' },
        { at: '2026-05-02T09:00:00.000Z', by: 'errors-loop', message: 'root cause found' },
      ],
      note: 'imported',
    });
    assert.equal(response.statusCode, 201);

    const item = (await get(project, '/items/migrated')).json().item;
    assert.equal(item.timeline.length, 3, 'two carried entries plus the import note');
    assert.equal(item.timeline[0].by, 'audit-sync');
    assert.equal(item.timeline[0].at.slice(0, 10), '2026-04-16');
    assert.equal(item.timeline[1].by, 'errors-loop');

    // A worker key must not be able to backdate somebody else's words.
    const minted = await post(project, '/keys', { name: 'worker', role: 'write' });
    const asWorker = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: { authorization: `Bearer ${minted.json().token}` },
      payload: {
        slug: 'forged',
        title: 'x',
        actor: 'worker',
        history: [{ at: '2020-01-01T00:00:00.000Z', by: 'somebody-else', message: 'I said this' }],
      },
    });
    assert.equal(asWorker.statusCode, 403);

    const rejected = await post(project, '/items', {
      slug: 'bad-history',
      title: 'x',
      actor: 'migration',
      history: [{ at: 'not a date', message: 'nope' }],
    });
    assert.equal(rejected.statusCode, 400);

    // Re-running a migration after a failure must not append the history twice.
    await post(project, '/items', {
      slug: 'migrated',
      title: 'came from the old board',
      actor: 'migration',
      history: [
        { at: '2026-04-16T20:16:55.485Z', by: 'audit-sync', message: 'first sighting' },
        { at: '2026-05-02T09:00:00.000Z', by: 'errors-loop', message: 'root cause found' },
      ],
    });
    const rerun = (await get(project, '/items/migrated')).json().item;
    assert.equal(rerun.timeline.filter((e: { message: string }) => e.message === 'first sighting').length, 1);
  });

  it('puts carried history in chronological order whatever order it arrives in', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'unsorted',
      title: 'x',
      actor: 'migration',
      history: [
        { at: '2026-05-02T09:00:00.000Z', by: 'b', message: 'second' },
        { at: '2026-04-16T20:16:55.485Z', by: 'a', message: 'first' },
      ],
    });
    const item = (await get(project, '/items/unsorted')).json().item;
    assert.equal(item.timeline[0].message, 'first');
    assert.equal(item.timeline[1].message, 'second');
  });

  it('enforces the project item cap', async () => {
    const project = await createProject(harness);
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'limits.items': 1 } },
    );
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    const second = await post(project, '/items', { slug: 'two', title: 'two', actor: 'a' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'limit_reached');
  });
});

describe('claims', () => {
  it('gives the item to one agent and names the holder to the other', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const first = await post(project, '/items/work/claim', { agent: 'agent-a', ttl_minutes: 30 });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().ok, true);

    const second = await post(project, '/items/work/claim', { agent: 'agent-b' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().held_by, 'agent-a');
  });

  it('lets the holder extend and release, and the next agent take over', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items/work/claim', { agent: 'agent-a' });

    const beat = await post(project, '/items/work/heartbeat', { agent: 'agent-a', ttl_minutes: 90 });
    assert.equal(beat.statusCode, 200);

    const wrongHolder = await post(project, '/items/work/heartbeat', { agent: 'agent-b' });
    assert.equal(wrongHolder.statusCode, 409);

    await post(project, '/items/work/release', { agent: 'agent-a', note: 'handing over' });
    const taken = await post(project, '/items/work/claim', { agent: 'agent-b' });
    assert.equal(taken.json().ok, true);
  });
});

describe('next', () => {
  it('offers work inside the declared scope and refuses to hand over somebody else’s', async () => {
    const project = await createProject(harness);
    await post(project, '/agents', { handle: 'errors-loop', scope: ['errors:'] });
    await post(project, '/agents', { handle: 'trades-loop', scope: ['trades:'] });
    await post(project, '/items', { slug: 'errors:one', title: 'an error', actor: 'errors-loop' });
    await post(project, '/items', { slug: 'trades:one', title: 'a trade', actor: 'trades-loop' });

    const mine = await get(project, '/next?agent=errors-loop');
    assert.equal(mine.json().item.slug, 'errors:one');

    await post(project, '/items', { slug: 'errors:one', status: 'done', actor: 'errors-loop' });
    const empty = await get(project, '/next?agent=errors-loop');
    assert.equal(empty.json().item, null);
    assert.match(empty.json().reason, /belong to other scopes/);
  });

  it('hands a restarted agent back its own claim before anything else', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'mine', title: 'mine', priority: 0, actor: 'a' });
    await post(project, '/items', { slug: 'shinier', title: 'shinier', priority: 5, actor: 'a' });
    await post(project, '/items/mine/claim', { agent: 'agent-a', ttl_minutes: 60 });

    const next = await get(project, '/next?agent=agent-a');
    assert.equal(next.json().item.slug, 'mine');
    assert.match(next.json().reason, /you already hold this claim/);
  });

  it('skips items another agent already holds', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });
    await post(project, '/items', { slug: 'two', title: 'two', actor: 'a' });
    await post(project, '/items/one/claim', { agent: 'agent-a' });
    const next = await get(project, '/next?agent=agent-b');
    assert.equal(next.json().item.slug, 'two');
  });
});

describe('scope warnings', () => {
  it('warns on a cross-scope write without blocking it', async () => {
    const project = await createProject(harness);
    await post(project, '/agents', { handle: 'dashboard-loop', scope: ['dashboard:'] });
    const response = await post(project, '/items', {
      slug: 'errors:not-mine',
      title: 'someone else’s problem',
      actor: 'dashboard-loop',
    });
    assert.equal(response.statusCode, 201);
    const warnings = response.json().warnings as string[];
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /outside your declared scope/);
  });
});

describe('escalations', () => {
  it('carries a question to the operator and the answer back to the agent', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'bridge', title: 'bridge or wait', actor: 'errors-loop' });
    const created = await post(project, '/escalations', {
      agent: 'errors-loop',
      question: 'Bridge via the third venue or wait?',
      context: 'Pool depth too thin.',
      priority: 'high',
      item_slug: 'bridge',
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().escalation.id;

    const item = (await get(project, '/items/bridge')).json().item;
    assert.equal(item.timeline.at(-1).kind, 'escalated');

    const emptyInbox = await get(project, '/inbox?agent=errors-loop');
    assert.equal(emptyInbox.json().answers.length, 0);

    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const answer = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/escalations/${id}`,
      payload: 'status=answered&answer=Bridge+it',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(answer.statusCode, 303);

    const inbox = await get(project, '/inbox?agent=errors-loop');
    const answers = inbox.json().answers;
    assert.equal(answers.length, 1);
    assert.equal(answers[0].status, 'answered');
    assert.equal(answers[0].answer, 'Bridge it');
  });
});

describe('keys', () => {
  it('lets an admin token mint and revoke a write key, and stops a write key from doing it', async () => {
    const project = await createProject(harness);
    const minted = await post(project, '/keys', { name: 'worker-2', role: 'write' });
    assert.equal(minted.statusCode, 201);
    const writeToken = minted.json().token;
    const keyId = minted.json().key.id;

    const asWriter = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: { authorization: `Bearer ${writeToken}` },
      payload: { slug: 'from-worker', title: 'written by the second key', actor: 'worker-2' },
    });
    assert.equal(asWriter.statusCode, 201);

    const escalated = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/keys`,
      headers: { authorization: `Bearer ${writeToken}` },
      payload: { name: 'nope' },
    });
    assert.equal(escalated.statusCode, 403);

    const revoked = await harness.server.inject({
      method: 'DELETE',
      url: `${project.api}/keys/${keyId}`,
      headers: authed(project),
    });
    assert.equal(revoked.statusCode, 200);

    const afterRevoke = await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items`,
      headers: { authorization: `Bearer ${writeToken}` },
    });
    assert.equal(afterRevoke.statusCode, 401);
  });
});

describe('claiming a project', () => {
  it('removes the expiry, raises the limits and clears the child TTLs', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'kept', title: 'kept', actor: 'a' });

    const start = await post(project, '/claim', { email: 'human@example.com' });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().delivery, 'logged');

    const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
    assert.ok(pending);

    const wrong = await post(project, '/claim/verify', {
      email: 'human@example.com',
      code: '000000',
    });
    assert.equal(wrong.statusCode, 400);

    // The real code only exists in the email and the log, so the test plants a
    // known one rather than guessing.
    const { hashToken } = await import('../src/ids.js');
    await harness.store.claimCodes.updateOne(
      { _id: pending!._id },
      { $set: { codeHash: hashToken('123456') } },
    );

    const verified = await post(project, '/claim/verify', {
      email: 'human@example.com',
      code: '123456',
    });
    assert.equal(verified.statusCode, 200);
    const claimed = verified.json().project;
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.expires_at, null);
    assert.equal(claimed.tier, 'free');

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'kept' });
    assert.equal(item!.expiresAt, null);
  });
});

describe('rate limits', () => {
  it('answers 429 with retry-after once the project creation window is spent', async () => {
    const isolated = await startHarness({ LIMIT_CREATE_PROJECTS_PER_HOUR: '5' });
    try {
      for (let i = 0; i < 5; i += 1) {
        const ok = await isolated.server.inject({ method: 'POST', url: '/p', payload: {} });
        assert.equal(ok.statusCode, 201);
      }
      const limited = await isolated.server.inject({ method: 'POST', url: '/p', payload: {} });
      assert.equal(limited.statusCode, 429);
      assert.ok(Number(limited.headers['retry-after']) > 0);
    } finally {
      await isolated.stop();
    }
  });
});
