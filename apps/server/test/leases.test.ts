import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * One lease, whoever asks first.
 *
 * "Claims are leases" is the first thing this product says about itself, and
 * the whole coordination story rests on it: two agents that both believe they
 * hold one card do the same work twice and neither is told. `/next` selects
 * and claims in one update and a test has held that for a while, but the door
 * an agent uses when it picks its own work is a different one, and it is also
 * what the MCP `claim_item` tool calls.
 *
 * The guard is a single conditional write whose filter carries the claim state
 * and a snapshot of the blockers the decision was taken on. It is correct by
 * construction and it is exactly the shape a refactor turns into a read
 * followed by a write without anything looking wrong, which is why it is worth
 * a test that races it rather than one that reads it.
 */
describe('the lease under a race', () => {
  let harness: Harness;
  let project: Project;

  before(async () => {
    harness = await startHarness();
    project = await createProject(harness, 'a board a fleet shares');
  });

  after(async () => {
    await harness.stop();
  });

  const write = (path: string, payload: Record<string, unknown>) =>
    harness.server.inject({
      method: 'POST',
      url: `${project.api}${path}`,
      headers: authed(project),
      payload,
    });

  it('gives one card to one agent when ten ask for it at the same moment', async () => {
    await write('/items', { slug: 'the-one-card', title: 'work everybody wants', actor: 'filer' });

    const asked = await Promise.all(
      Array.from({ length: 10 }, (_, n) => write('/items/the-one-card/claim', { agent: `loop-${n}` })),
    );

    const won = asked.filter((answer) => answer.statusCode === 200);
    const lost = asked.filter((answer) => answer.statusCode !== 200);
    assert.equal(won.length, 1, `${won.length} agents were told they hold it`);
    assert.equal(lost.length, 9);

    const holder = won[0]!.json().item.claim.agent;
    for (const answer of lost) {
      assert.equal(answer.statusCode, 409);
      assert.equal(answer.json().ok, false);
      // Named, not merely refused: an agent that lost needs to know whether to
      // wait for a colleague or to go and find other work.
      assert.equal(answer.json().held_by, holder, 'the loser is told who has it');
    }

    // And the database agrees with the one answer that said yes.
    const stored = await harness.store.items.findOne({ projectId: project.id, slug: 'the-one-card' });
    assert.equal(stored?.claim?.agent, holder);
  });

  it('lets only the holder extend it, release it or write to it', async () => {
    const stored = await harness.store.items.findOne({ projectId: project.id, slug: 'the-one-card' });
    const holder = stored!.claim!.agent;
    const other = holder === 'loop-0' ? 'loop-1' : 'loop-0';

    const stolen = await write('/items/the-one-card/heartbeat', { agent: other });
    assert.equal(stolen.statusCode, 409, 'a heartbeat from somebody else is not an extension');
    const refused = await write('/items/the-one-card/release', { agent: other });
    assert.equal(refused.statusCode, 409, 'and nor is a release');

    const kept = await harness.store.items.findOne({ projectId: project.id, slug: 'the-one-card' });
    assert.equal(kept?.claim?.agent, holder, 'the lease is where it was');

    const extended = await write('/items/the-one-card/heartbeat', { agent: holder });
    assert.equal(extended.statusCode, 200);
    const handedBack = await write('/items/the-one-card/release', { agent: holder });
    assert.equal(handedBack.statusCode, 200);
    const free = await harness.store.items.findOne({ projectId: project.id, slug: 'the-one-card' });
    assert.equal(free?.claim, null, 'and it is free again');
  });

  it('serves ten agents ten cards, so one lease does not queue the rest', async () => {
    // The other half of the same guard: a filter that is too broad, or a lock
    // taken on the collection rather than on the row, turns a fleet into a
    // queue and nothing fails while it does.
    for (let n = 0; n < 10; n += 1) {
      await write('/items', { slug: `own-work-${n}`, title: `work ${n}`, actor: 'filer' });
    }
    const asked = await Promise.all(
      Array.from({ length: 10 }, (_, n) => write(`/items/own-work-${n}/claim`, { agent: `loop-${n}` })),
    );
    assert.equal(asked.filter((answer) => answer.statusCode === 200).length, 10);
    const held = await harness.store.items.countDocuments({
      projectId: project.id,
      slug: { $regex: '^own-work-' },
      'claim.agent': { $ne: null },
    });
    assert.equal(held, 10, 'every one of them is held by the agent that asked');
  });

  it('hands the card to the next agent once the lease has lapsed, and to only one', async () => {
    await write('/items', { slug: 'lapsing', title: 'held by somebody who stopped', actor: 'filer' });
    const first = await write('/items/lapsing/claim', { agent: 'the-one-that-crashed', ttl_minutes: 1 });
    assert.equal(first.statusCode, 200);

    // The crash: no heartbeat, and the lease is behind us. Written rather than
    // waited for, because a minute is a minute.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'lapsing' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 1000) } },
    );

    const asked = await Promise.all(
      Array.from({ length: 5 }, (_, n) => write('/items/lapsing/claim', { agent: `after-${n}` })),
    );
    const won = asked.filter((answer) => answer.statusCode === 200);
    assert.equal(won.length, 1, 'a lapsed lease is free once, not five times');
    assert.match(won[0]!.json().item.claim.agent, /^after-/, 'and the crashed session no longer holds it');
  });
});
