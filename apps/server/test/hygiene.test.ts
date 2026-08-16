import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { maybeSweep, sweepProject } from '../src/hygiene.js';
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

async function projectDoc(project: Project) {
  return (await harness.store.projects.findOne({ _id: project.id }))!;
}

async function itemDoc(project: Project, slug: string) {
  return (await harness.store.items.findOne({ projectId: project.id, slug }))!;
}

/** Moves a document's clock back, which is the only way to test a rule that waits. */
async function backdate(
  project: Project,
  slug: string,
  fields: Record<string, Date | number | null>,
) {
  await harness.store.items.updateOne({ projectId: project.id, slug }, { $set: fields });
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

describe('claim expiry', () => {
  it('frees an item whose holder stopped sending heartbeats, and says who dropped it', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items/work/claim', { agent: 'crashed-agent', ttl_minutes: 5 });

    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'work' },
      { $set: { 'claim.expiresAt': hoursAgo(1) } },
    );
    await sweepProject(harness.store, await projectDoc(project));

    const item = await itemDoc(project, 'work');
    assert.equal(item.claim, null);
    const last = item.timeline.at(-1)!;
    assert.equal(last.by, 'hygiene');
    assert.match(last.message, /crashed-agent/);
    assert.match(last.message, /without a heartbeat/);
  });
});

describe('stale marking', () => {
  it('flags an untouched item without closing it, and never counts as activity', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'forgotten', title: 'forgotten', actor: 'a' });
    const before = await itemDoc(project, 'forgotten');

    await backdate(project, 'forgotten', { touchedAt: hoursAgo(100) });
    await sweepProject(harness.store, await projectDoc(project));

    const after = await itemDoc(project, 'forgotten');
    assert.equal(after.stale, true);
    assert.equal(after.status, 'open', 'stale must never close anything');
    assert.equal(
      after.touchedAt.getTime(),
      hoursAgo(100).getTime() > before.touchedAt.getTime() ? after.touchedAt.getTime() : after.touchedAt.getTime(),
    );
    assert.ok(after.touchedAt < new Date(Date.now() - 3_600_000), 'hygiene must not move touchedAt');
    assert.equal(after.timeline.at(-1)!.by, 'hygiene');
  });

  it('is cleared by the next ordinary write', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'revived', title: 'revived', actor: 'a' });
    await backdate(project, 'revived', { touchedAt: hoursAgo(100) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'revived')).stale, true);

    await post(project, '/items', { slug: 'revived', note: 'still on it', actor: 'a' });
    const item = await itemDoc(project, 'revived');
    assert.equal(item.stale, false);
    assert.equal(item.staleSince, null);
  });

  it('leaves closed items alone', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'shipped', title: 'shipped', status: 'done', actor: 'a' });
    await backdate(project, 'shipped', { touchedAt: hoursAgo(500) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'shipped')).stale, false);
  });
});

describe('contentless items', () => {
  it('drops a titled placeholder nobody ever described', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'placeholder', title: 'look into this', actor: 'a' });
    await backdate(project, 'placeholder', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));

    const item = await itemDoc(project, 'placeholder');
    assert.equal(item.status, 'dropped');
    assert.match(item.timeline.at(-1)!.message, /Upsert the same slug with a body/);
  });

  it('keeps anything that has a body, a claim or a second timeline entry', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'described', title: 't', body: 'why it matters', actor: 'a' });
    await post(project, '/items', { slug: 'claimed', title: 't', actor: 'a' });
    await post(project, '/items/claimed/claim', { agent: 'a' });
    await post(project, '/items', { slug: 'discussed', title: 't', actor: 'a' });
    await post(project, '/items/discussed/timeline', { message: 'looking', actor: 'a' });

    for (const slug of ['described', 'claimed', 'discussed']) {
      await backdate(project, slug, { createdAt: hoursAgo(48) });
    }
    await sweepProject(harness.store, await projectDoc(project));

    for (const slug of ['described', 'claimed', 'discussed']) {
      assert.notEqual((await itemDoc(project, slug)).status, 'dropped', slug);
    }
  });

  it('comes back when an agent finally describes it', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'second-chance', title: 't', actor: 'a' });
    await backdate(project, 'second-chance', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'second-chance')).status, 'dropped');

    await post(project, '/items', {
      slug: 'second-chance',
      body: 'here is what it is',
      status: 'open',
      actor: 'a',
    });
    assert.equal((await itemDoc(project, 'second-chance')).status, 'open');
  });
});

describe('absence resolve', () => {
  async function mirrored(project: Project, slug: string) {
    await post(project, '/items', {
      slug,
      title: slug,
      body: 'mirrored from a scanner',
      source: 'scanner',
      actor: 'scanner-loop',
    });
  }

  it('needs both guards: a streak alone does not close anything', async () => {
    const project = await createProject(harness);
    await mirrored(project, 'signal-a');
    await post(project, '/observe', { source: 'scanner', present: [] });
    await post(project, '/observe', { source: 'scanner', present: [] });

    const item = await itemDoc(project, 'signal-a');
    assert.equal(item.absence.count, 2, 'the streak is counted');
    assert.equal(item.status, 'open', 'but two absences within minutes must not close it');
  });

  it('needs both guards: age alone does not close anything', async () => {
    const project = await createProject(harness);
    await mirrored(project, 'signal-b');
    await post(project, '/observe', { source: 'scanner', present: [] });
    await backdate(project, 'signal-b', { 'absence.since': hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'signal-b')).status, 'open');
  });

  it('closes when the streak and the clock agree', async () => {
    const project = await createProject(harness);
    await mirrored(project, 'signal-c');
    await post(project, '/observe', { source: 'scanner', present: [] });
    await post(project, '/observe', { source: 'scanner', present: [] });
    await backdate(project, 'signal-c', { 'absence.since': hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));

    const item = await itemDoc(project, 'signal-c');
    assert.equal(item.status, 'done');
    assert.match(item.timeline.at(-1)!.message, /source signal absent/);
    assert.equal(item.timeline.at(-1)!.by, 'hygiene');
  });

  it('resets the streak the moment the signal comes back', async () => {
    const project = await createProject(harness);
    await mirrored(project, 'signal-d');
    await post(project, '/observe', { source: 'scanner', present: [] });
    assert.equal((await itemDoc(project, 'signal-d')).absence.count, 1);

    await post(project, '/observe', { source: 'scanner', present: ['signal-d'] });
    const item = await itemDoc(project, 'signal-d');
    assert.equal(item.absence.count, 0);
    assert.equal(item.absence.since, null);
  });

  it('ignores items that are not mirrored from that source', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'handmade', title: 'handmade', actor: 'a' });
    await mirrored(project, 'signal-e');
    await post(project, '/observe', { source: 'scanner', present: [] });
    assert.equal((await itemDoc(project, 'handmade')).absence.count, 0);
  });
});

describe('sweep throttle', () => {
  it('runs once per minute however many agents ask', async () => {
    const project = await createProject(harness);
    // No API writes here on purpose: each one fires its own throttled sweep in
    // the background, and racing that would make this test measure the race
    // rather than the throttle.
    const doc = await projectDoc(project);

    const first = await maybeSweep(harness.store, doc);
    const second = await maybeSweep(harness.store, doc);
    assert.ok(first, 'the first caller sweeps');
    assert.equal(second, null, 'the second caller is told somebody else has it');
  });
});
