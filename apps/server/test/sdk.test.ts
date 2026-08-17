import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
// Imported from source rather than from the built package so a broken SDK
// fails this suite instead of silently testing a stale dist.
import { Muster } from '../../../packages/sdk/src/index.js';
import { startHarness, type Harness } from './helper.js';

let harness: Harness;
let baseUrl: string;

before(async () => {
  harness = await startHarness();
  const address = await harness.server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
});

after(async () => {
  await harness.stop();
});

describe('the typed SDK', () => {
  it('drives a whole session: signup, register, upsert, claim, escalate, inbox', async () => {
    const { client, created } = await Muster.start({
      name: 'sdk-session',
      actor: 'errors-loop',
      baseUrl,
    });
    assert.match(created.token, /^mk_/);

    await client.registerAgent({ handle: 'errors-loop', scope: ['errors:'] });

    const upserted = await client.upsert({
      slug: 'errors:one',
      title: 'first problem',
      body: 'details',
    });
    assert.equal(upserted.created, true);
    assert.equal(upserted.item.status, 'open');

    const next = await client.next();
    assert.equal(next.item?.slug, 'errors:one');

    const claimed = await client.claim('errors:one');
    assert.equal(claimed.ok, true);

    const contested = new Muster({
      project: created.project,
      token: created.token,
      baseUrl,
      actor: 'other-loop',
    });
    const refused = await contested.claim('errors:one');
    assert.equal(refused.ok, false);
    assert.equal(refused.held_by, 'errors-loop');

    await client.note('errors:one', 'pool depth too thin');
    const escalated = await client.escalate({
      question: 'bridge or wait?',
      itemSlug: 'errors:one',
      priority: 'high',
    });
    assert.equal(escalated.escalation.status, 'open');

    const inbox = await client.inbox();
    assert.equal(inbox.answers.length, 0);

    await client.release('errors:one');
    const taken = await contested.claim('errors:one');
    assert.equal(taken.ok, true);
  });

  it('withClaim runs the work, keeps the lease and releases it even after a throw', async () => {
    const { client } = await Muster.start({ name: 'with-claim', actor: 'worker', baseUrl });
    await client.upsert({ slug: 'job', title: 'a job' });

    const done = await client.withClaim('job', async (item) => {
      assert.equal(item.slug, 'job');
      const held = await client.item('job');
      assert.equal(held.item.claim?.agent, 'worker');
      return 'finished';
    });
    assert.equal(done, 'finished');
    assert.equal((await client.item('job')).item.claim, null);

    await assert.rejects(
      client.withClaim('job', async () => {
        throw new Error('work blew up');
      }),
      /work blew up/,
    );
    assert.equal((await client.item('job')).item.claim, null, 'a throw must not leak the lease');
  });

  it('returns null from withClaim instead of duplicating somebody else’s work', async () => {
    const { client, created } = await Muster.start({ name: 'contended', actor: 'first', baseUrl });
    await client.upsert({ slug: 'job', title: 'a job' });
    await client.claim('job', 'first', 60);

    const second = new Muster({
      project: created.project,
      token: created.token,
      baseUrl,
      actor: 'second',
    });
    let ran = false;
    const result = await second.withClaim('job', async () => {
      ran = true;
      return 'should not happen';
    });
    assert.equal(result, null);
    assert.equal(ran, false);
  });

  it('throws on a 409 that is a real failure, and only passes the contested claim through', async () => {
    const { client, created } = await Muster.start({ name: 'conflicts', actor: 'a', baseUrl });
    await client.upsert({ slug: 'held', title: 'held' });
    await client.claim('held', 'a', 60);

    // A heartbeat from the wrong agent is a failure, not a result. Swallowing it
    // would let the caller carry on believing it holds the lease.
    await assert.rejects(client.heartbeat('held', 'someone-else'), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.equal((error as { code?: string }).code, 'not_claim_holder');
      return true;
    });

    // A full project is a failure too.
    const direct = await fetch(`${baseUrl}/v1/${created.project}/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', title: 'x', actor: 'a' }),
    });
    assert.ok(direct.ok);
    await harness.store.projects.updateOne(
      { _id: created.project },
      { $set: { 'limits.items': 1 } },
    );
    await assert.rejects(client.upsert({ slug: 'over-the-cap', title: 'nope' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'limit_reached');
      return true;
    });

    // The contested claim still comes back as an answer.
    const contested = await new Muster({
      project: created.project,
      token: created.token,
      baseUrl,
      actor: 'b',
    }).claim('held');
    assert.equal(contested.ok, false);
    assert.equal(contested.held_by, 'a');
  });

  it('migrates history, answers a question and pages through the queue', async () => {
    const { client } = await Muster.start({ name: 'migration', actor: 'importer', baseUrl });

    await client.upsert({
      slug: 'from-elsewhere',
      title: 'came from another system',
      history: [
        { at: '2026-05-02T09:00:00.000Z', by: 'old-loop', message: 'second' },
        { at: '2026-04-16T20:16:55.485Z', by: 'old-loop', message: 'first' },
      ],
    });
    const migrated = await client.item('from-elsewhere');
    assert.equal(migrated.item.timeline?.[0]?.message, 'first');
    assert.equal(migrated.item.timeline?.[0]?.by, 'old-loop');

    for (let i = 0; i < 3; i += 1) {
      await client.escalate({ question: `question ${i}` });
    }
    const everything = await client.allEscalations();
    assert.equal(everything.length, 3);

    const answered = await client.answer(everything[0]!.id, 'wont_do', 'not this week');
    assert.equal(answered.escalation.status, 'wont_do');
    const inbox = await client.inbox();
    assert.equal(inbox.answers.length, 1);

    await client.deleteItem('from-elsewhere');
    await assert.rejects(client.item('from-elsewhere'));
  });

  it('reads and lays out the board, and hands the project to a person', async () => {
    const { client, created } = await Muster.start({
      name: 'sdk-board',
      description: 'what this board is for',
      actor: 'errors-loop',
      baseUrl,
    });
    assert.equal(created.description, 'what this board is for');

    await client.upsert({ slug: 'watch', title: 'watching', labels: ['monitoring'] });
    await client.upsert({ slug: 'busy', title: 'busy' });
    await client.claim('busy', 'errors-loop', 30);

    const before = await client.board();
    assert.equal(before.rows[0]?.columns.find((cell) => cell.key === 'doing')?.count, 1);

    await client.setBoard({
      rows: 'none',
      columns: [
        { title: 'Monitoring', match: { labels: ['monitoring'], status: ['open'] } },
        { title: 'Rest', match: {} },
      ],
    });
    const after = await client.board();
    assert.deepEqual(
      after.board.columns.map((column) => column.title),
      ['Monitoring', 'Rest'],
    );
    assert.equal(after.rows[0]?.columns[0]?.items?.[0]?.slug, 'watch');

    const presets = await client.boardPresets();
    assert.ok(presets.presets.length >= 3);

    const moved = await client.move('busy', 'monitoring', { note: 'watching it instead' });
    assert.equal(moved.landed_in, 'monitoring');
    assert.ok(moved.item.labels.includes('monitoring'));

    const shared = await client.share({ email: 'nobody@example.com', note: 'yours now' });
    assert.equal(shared.ok, true);
    assert.match(shared.tell_them!, /\/r\/r_/);

    const described = await client.describe({ description: 'renamed from the SDK' });
    assert.equal(described.description, 'renamed from the SDK');
  });

  it('raises a typed error with the server’s own message', async () => {
    const { client } = await Muster.start({ name: 'errors', actor: 'a', baseUrl });
    await assert.rejects(client.item('nothing-here'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 404);
      assert.equal((error as { code?: string }).code, 'not_found');
      return true;
    });
  });
});
