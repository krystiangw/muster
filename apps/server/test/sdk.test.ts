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
