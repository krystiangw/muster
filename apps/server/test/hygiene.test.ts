import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { lapsedLeaseFilter, maybeSweep, sweepProject } from '../src/hygiene.js';
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

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
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

  it('clears a lease left on finished work by a move that never finished', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items', { slug: 'work', status: 'done', actor: 'a' });

    // The state a crash can leave and a request cannot: the reopening move
    // takes the lease first and dies before it writes the status. Staged here,
    // because the door refuses to produce it and that is the point.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'work' },
      {
        $set: {
          claim: {
            agent: 'crashed-mover',
            claimedAt: minutesAgo(30),
            heartbeatAt: minutesAgo(30),
            expiresAt: hoursAgo(-1),
            nonce: 'l_crashedmove',
          },
        },
      },
    );
    await sweepProject(harness.store, await projectDoc(project));

    const item = await itemDoc(project, 'work');
    assert.equal(item.claim, null, 'finished work does not stay held');
    assert.equal(item.status, 'done', 'and the sweep does not decide the work is open again');
    const last = item.timeline.at(-1)!;
    assert.equal(last.by, 'hygiene');
    assert.match(last.message, /crashed-mover/);
    assert.match(last.message, /move that did not finish/);
  });

  it('leaves a lease a reopening move is still in the middle of using', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items', { slug: 'work', status: 'done', actor: 'a' });

    // Same shape, seconds old rather than minutes: this is a move in flight,
    // and sweeping it would take the lease out from under a caller that is
    // about to write the status. The grace is what tells the two apart.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'work' },
      {
        $set: {
          claim: {
            agent: 'mover',
            claimedAt: new Date(),
            heartbeatAt: new Date(),
            expiresAt: hoursAgo(-1),
            nonce: 'l_inflight',
          },
        },
      },
    );
    await sweepProject(harness.store, await projectDoc(project));

    const item = await itemDoc(project, 'work');
    assert.equal(item.claim?.agent, 'mover');
  });
});

describe('what the lease sweep costs a read', () => {
  it('walks the claimed items and not the history behind them', async () => {
    const project = await createProject(harness);
    // A project with a past: the sweep runs on the read path, and a branch
    // that cannot use the claims index would walk every one of these.
    await harness.store.items.insertMany(
      Array.from({ length: 400 }, (_, index) => ({
        _id: `i_history${index}`,
        projectId: project.id,
        slug: `old:${index}`,
        title: 'finished long ago',
        body: '',
        status: 'done' as const,
        owner: null,
        priority: 0,
        labels: [],
        blockedBy: [],
        source: null,
        fields: {},
        stale: false,
        staleSince: null,
        claim: null,
        timeline: [],
        timelineCount: 0,
        lastActor: 'a',
        closedAt: hoursAgo(80),
        createdAt: hoursAgo(90),
        updatedAt: hoursAgo(80),
        touchedAt: hoursAgo(80),
      })) as never,
    );
    await post(project, '/items', { slug: 'live', title: 'live', actor: 'a' });
    await post(project, '/items/live/claim', { agent: 'holder' });

    const plan = await harness.store.items
      .find(lapsedLeaseFilter(project.id, new Date()))
      .explain('executionStats');
    const examined = (plan as { executionStats: { totalDocsExamined: number } }).executionStats
      .totalDocsExamined;
    assert.ok(
      examined < 50,
      `the sweep read ${examined} documents to find the leases in a project holding one`,
    );
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

  it('comes back when an agent finally describes it, saying nothing about status', async () => {
    // Exactly what the line hygiene wrote says to do, and nothing more. This
    // test used to send `status: 'open'` beside the body, which is the
    // workaround rather than the promise: it passed for months while doing
    // what the card actually told you to do left it dropped. The engine's
    // third invariant is that an ordinary upsert undoes the machine, and an
    // upsert that has to name the status is not an ordinary one.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'second-chance', title: 't', actor: 'a' });
    await backdate(project, 'second-chance', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'second-chance')).status, 'dropped');

    await post(project, '/items', { slug: 'second-chance', body: 'here is what it is', actor: 'a' });
    const back = await itemDoc(project, 'second-chance');
    assert.equal(back.status, 'open');
    assert.equal(back.body, 'here is what it is');
    assert.equal(back.closedAt, null, 'and it is not carrying the time it was closed');
  });

  it('stops undoing a close that somebody affirmed, even in the same words', async () => {
    // Naming a status takes ownership of where the card is, and naming the one
    // it already has is still naming it. Without this, a caller who said
    // `status: dropped` on a card hygiene had dropped would find the next
    // write with no status at all putting it back.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'affirmed', title: 't', actor: 'a' });
    await backdate(project, 'affirmed', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'affirmed')).status, 'dropped');

    await post(project, '/items', { slug: 'affirmed', status: 'dropped', actor: 'a' });
    await post(project, '/items', { slug: 'affirmed', body: 'described after all', actor: 'a' });
    assert.equal((await itemDoc(project, 'affirmed')).status, 'dropped');
  });

  it('loses the reopening to somebody affirming the close at the same moment', async () => {
    // Two writes arriving together: one saying the card stays dropped, one
    // describing it. Whichever reads first, the card must not end up open,
    // and that only holds if the undo is guarded on the marker it read rather
    // than on the status alone: affirming a close clears the marker and
    // leaves the status where it is, so a status guard sees no change at all.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'raced', title: 't', actor: 'a' });
    await backdate(project, 'raced', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'raced')).status, 'dropped');

    await Promise.all([
      post(project, '/items', { slug: 'raced', status: 'dropped', actor: 'a' }),
      post(project, '/items', { slug: 'raced', body: 'described', actor: 'a' }),
    ]);
    assert.equal((await itemDoc(project, 'raced')).status, 'dropped');
  });

  it('does not reopen on a write that is guarded on what the caller last saw', async () => {
    // This service refuses a guarded write that also moves a status, and says
    // so in as many words: the correction first, the move after. Reopening on
    // the caller's behalf would break that rule from the inside.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'guarded', title: 't', actor: 'a' });
    await backdate(project, 'guarded', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'guarded')).status, 'dropped');

    const answer = await post(project, '/items', {
      slug: 'guarded',
      body: 'described, carefully',
      expect: { title: 't' },
      actor: 'a',
    });
    assert.equal(answer.statusCode, 200, answer.body);
    assert.equal((await itemDoc(project, 'guarded')).status, 'dropped');
    assert.equal((await itemDoc(project, 'guarded')).body, 'described, carefully');
  });

  it('counts the card it brings back, so the board can still refuse at the limit', async () => {
    // A reopening costs a slot, and a slot that is not taken is a limit that
    // stops meaning anything: the counter is what the capacity check reads,
    // and there is a repair pass in this file whose whole job is undoing
    // drift like it. Counted here rather than trusted, because the undo goes
    // through the transition sideways.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'counted', title: 't', actor: 'a' });
    await backdate(project, 'counted', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    const closed = (await projectDoc(project)).counts.items;

    await post(project, '/items', { slug: 'counted', body: 'described', actor: 'a' });
    const open = await harness.store.items.countDocuments({
      projectId: project.id,
      status: { $nin: ['done', 'dropped'] },
    });
    assert.equal((await projectDoc(project)).counts.items, closed + 1, 'the slot was taken');
    assert.equal((await projectDoc(project)).counts.items, open, 'and it matches what is actually open');
  });

  it('leaves a card somebody dropped on purpose where they put it', async () => {
    // The other half of the same rule. Finished work stays finished, whoever
    // finished it, and describing it afterwards is not a decision to reopen:
    // that is the rule the claim door keeps, and it would be worth nothing if
    // an ordinary write could walk around it.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'by-hand', title: 't', actor: 'a' });
    await post(project, '/items', { slug: 'by-hand', status: 'dropped', actor: 'a' });

    await post(project, '/items', { slug: 'by-hand', body: 'somebody wrote a description', actor: 'a' });
    const still = await itemDoc(project, 'by-hand');
    assert.equal(still.status, 'dropped');
    assert.equal(still.body, 'somebody wrote a description', 'the description landed all the same');
  });

  it('says why it stayed dropped when the board has no room to reopen it', async () => {
    // Refusing the write would be refusing the description, which is the part
    // that was asked for and the part that stops it being dropped again
    // tomorrow. So the body lands, the card does not move, and the answer says
    // so rather than leaving somebody to notice.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'placeholder', title: 't', actor: 'a' });
    await backdate(project, 'placeholder', { createdAt: hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'placeholder')).status, 'dropped');

    // One open card and room for exactly that one, so the reopening is the
    // write that would not fit.
    await post(project, '/items', { slug: 'one', title: 'one', body: 'x', actor: 'a' });
    await harness.store.projects.updateOne({ _id: project.id }, { $set: { 'limits.items': 1 } });

    const answer = await post(project, '/items', { slug: 'placeholder', body: 'described at last', actor: 'a' });
    assert.equal(answer.statusCode, 200);
    const said = JSON.stringify(answer.json());
    assert.match(said, /open item limit/);
    assert.equal((await itemDoc(project, 'placeholder')).status, 'dropped');
    assert.equal((await itemDoc(project, 'placeholder')).body, 'described at last');
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
    // And it says how to get it back, the way the drop rule does. A card that
    // closed itself and does not say what undoes it is a card somebody
    // reopens by hand, or does not reopen at all.
    assert.match(item.timeline.at(-1)!.message, /Write to this slug again/);
  });

  it('opens again when the thing it mirrors comes back', async () => {
    // The half that was missing. Absence closed the card and presence reset
    // the streak, which left a resolved card resolved through every return of
    // the signal it mirrors: an error that came back was invisible to the loop
    // that filed it, because the loop upserts what it sees and an upsert that
    // names no status moved nothing. A card the machine closed is reopened by
    // an ordinary write, which is the third invariant this engine claims.
    const project = await createProject(harness);
    await mirrored(project, 'signal-again');
    await post(project, '/observe', { source: 'scanner', present: [] });
    await post(project, '/observe', { source: 'scanner', present: [] });
    await backdate(project, 'signal-again', { 'absence.since': hoursAgo(48) });
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'signal-again')).status, 'done');

    await post(project, '/items', { slug: 'signal-again', body: 'the venue is refusing again', actor: 'scanner' });
    assert.equal((await itemDoc(project, 'signal-again')).status, 'open');
  });

  it('leaves a mirrored card somebody resolved by hand resolved', async () => {
    const project = await createProject(harness);
    await mirrored(project, 'signal-by-hand');
    await post(project, '/items', { slug: 'signal-by-hand', status: 'done', actor: 'a' });

    await post(project, '/items', { slug: 'signal-by-hand', body: 'still writing about it', actor: 'scanner' });
    assert.equal((await itemDoc(project, 'signal-by-hand')).status, 'done');
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

describe('what a read is allowed to tidy', () => {
  it('clears a lapsed lease, because a lapsed lease is free work', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'held', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items/held/claim', { agent: 'a' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'held' },
      { $set: { 'claim.expiresAt': hoursAgo(1) } },
    );
    // The read path has a throttle of its own, and creating the item above
    // took the slot. Move it back or this measures the throttle.
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { leasesSweptAt: hoursAgo(1) } },
    );

    await harness.server.inject({
      method: 'GET',
      url: `${project.api}/items`,
      headers: authed(project),
    });
    // The write lands after the response, so read the row until it clears
    // rather than once: the assertion is that it happens, not when.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await itemDoc(project, 'held')).claim === null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await itemDoc(project, 'held')).claim, null);
  });

  it('does not close work, however contentless the board is', async () => {
    // The rule this protects is one sentence: reading the board expires
    // lapsed leases and nothing else. It is what lets the MCP tools say they
    // are not destructive, and a client weighs that annotation when it decides
    // whether to run a tool without asking a person first.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'placeholder', title: 'look into this', actor: 'a' });
    // The write's own sweep is fired and not awaited, so without this pause it
    // can land after the backdating line below and drop the item itself, which
    // would fail this test for the one reason it is not about.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await backdate(project, 'placeholder', { createdAt: hoursAgo(48) });
    // Both throttles opened, so nothing here is explained by one being held.
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { leasesSweptAt: hoursAgo(1), lastSweptAt: hoursAgo(1) } },
    );

    for (const url of [`${project.api}/items`, `${project.api}/board`, project.api]) {
      await harness.server.inject({ method: 'GET', url, headers: authed(project) });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      (await itemDoc(project, 'placeholder')).status,
      'open',
      'a read must not drop an item, however contentless it is',
    );

    // And the rest of hygiene still runs, from the timer or from a write.
    await sweepProject(harness.store, await projectDoc(project));
    assert.equal((await itemDoc(project, 'placeholder')).status, 'dropped');
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
