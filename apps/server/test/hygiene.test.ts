import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { maybeSweep, sweepProject } from '../src/hygiene.js';
import { projectJson } from '../src/serialize.js';
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
  it('leaves alone an item somebody is holding, and flags it the moment they let go', async () => {
    // A heartbeat deliberately does not move touchedAt: it says "still on it",
    // not "here is what I learned". So an agent working an item for longer
    // than the stale window, and heartbeating it correctly the whole time,
    // used to watch the board call its work rotten.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'long-haul', title: 'a long job', actor: 'a' });
    await post(project, '/items/long-haul/claim', { agent: 'a', ttl_minutes: 60 });
    await backdate(project, 'long-haul', { touchedAt: hoursAgo(100) });

    await sweepProject(harness.store, await projectDoc(project));
    const held = await itemDoc(project, 'long-haul');
    assert.equal(held.stale, false, 'somebody is demonstrably on it');

    // The lease lapses, the claim sweep clears it, and the same pass marks it:
    // touchedAt was old the whole time, so nothing is owed a second window.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'long-haul' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );
    await sweepProject(harness.store, await projectDoc(project));
    const dropped = await itemDoc(project, 'long-haul');
    assert.equal(dropped.claim, null);
    assert.equal(dropped.stale, true, 'and the moment nobody holds it, it is stale');
  });

  it('clears a flag it set on held work before the exemption existed', async () => {
    // Forward-only would have been half a fix: a heartbeat writes neither
    // `stale` nor `touchedAt`, and releasing the claim clears no flag either,
    // so an item marked once under a live claim would carry it for as long as
    // it exists.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'held', title: 'held', actor: 'a' });
    await post(project, '/items/held/claim', { agent: 'a', ttl_minutes: 60 });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'held' },
      { $set: { stale: true, staleSince: new Date(Date.now() - 86_400_000) } },
    );

    await sweepProject(harness.store, await projectDoc(project));
    const item = await itemDoc(project, 'held');
    assert.equal(item.stale, false);
    assert.equal(item.staleSince, null);
    assert.match(item.timeline.at(-1)!.message, /stale flag was cleared/);
    assert.equal(item.timeline.at(-1)!.by, 'hygiene');
  });

  it('clears a legacy flag when the holder lets go, and when the rule is off', async () => {
    // Two ways the repair pass alone would never reach an item: the holder
    // releases it before the next sweep, and a project that has since turned
    // stale marking off entirely.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'let-go', title: 'let go', actor: 'a' });
    await post(project, '/items/let-go/claim', { agent: 'a' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'let-go' },
      { $set: { stale: true, staleSince: new Date(Date.now() - 86_400_000) } },
    );
    await post(project, '/items/let-go/release', { agent: 'a' });
    assert.equal((await itemDoc(project, 'let-go')).stale, false, 'letting go is a write like any other');

    await post(project, '/items', { slug: 'rule-off', title: 'rule off', actor: 'a' });
    await post(project, '/items/rule-off/claim', { agent: 'a' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'rule-off' },
      { $set: { stale: true, staleSince: new Date(Date.now() - 86_400_000) } },
    );
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { 'rules.staleAfterHours': null } },
    );
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'rule-off')).stale, false);
  });

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
  it('says when hygiene last looked, so a dead sweeper is not silence', async () => {
    // A board with nothing to tidy and a board nobody is tidying produce the
    // same output: no stale flags, no expired claims, no log line. The date is
    // the only thing that tells them apart, and the watchdog reads it over the
    // API rather than holding a database password.
    const project = await createProject(harness);
    const read = async () =>
      (
        await harness.server.inject({ method: 'GET', url: project.api, headers: authed(project) })
      ).json() as Record<string, unknown>;

    const before = await read();
    assert.ok('swept_at' in before, 'the field is there to be read');

    // sweepProject rather than maybeSweep: creating and reading a project each
    // fire a throttled sweep of their own, so the explicit one would be told
    // somebody already holds the slot and this would prove nothing.
    await sweepProject(harness.store, await projectDoc(project));
    const after = await read();
    assert.ok(
      Date.now() - new Date(after.swept_at as string).getTime() < 60_000,
      'a sweep that finished is what puts a date there',
    );

    // And the person who owns the board can see it without an API call: the
    // stale flags on that page are exactly as old as this line says they are.
    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /Hygiene last looked/);

    // In memory rather than through the database and back: several routes fire
    // a throttled sweep of their own, and one of those landing after a
    // backdating write would make this measure the race instead of the field.
    const doc = await projectDoc(project);
    // One instant, used by both readings below. Two calls to Date.now() a
    // microsecond apart made this fail on a slower machine by exactly 1 ms,
    // which is a test measuring its own execution rather than the field.
    const anHourAgo = new Date(Date.now() - 3_600_000);
    const stalled = projectJson({ ...doc, sweptAt: anHourAgo }, harness.config);
    assert.ok(
      Date.now() - new Date(stalled.swept_at as Date).getTime() > 3_000_000,
      'an hour without a sweep reads as an hour, which is what an alert needs',
    );

    // The reported date is not the throttle marker. maybeSweep takes that one
    // on the way in, so on a deployment where every pass throws it would keep
    // moving and report a sweeper that has not finished anything in days as
    // one that ran a minute ago.
    const claimed = projectJson(
      { ...doc, lastSweptAt: new Date(), sweptAt: anHourAgo },
      harness.config,
    );
    assert.equal(
      (claimed.swept_at as Date).getTime(),
      (stalled.swept_at as Date).getTime(),
      'claiming the throttle is not finishing a sweep',
    );
  });

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
