import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../src/ids.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * One project is one board with one identity. An agent creates it, describes it
 * and hands it to a person, who ends up owning every board they were handed
 * without confirming an emailed code once per project.
 */

let harness: Harness;

before(async () => {
  harness = await startHarness({ LIMIT_CLAIM_EMAILS_PER_HOUR: '100' });
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

async function claimFor(project: Project, email: string): Promise<void> {
  await post(project, '/claim', { email });
  const pending = await harness.store.claimCodes.findOne({ projectId: project.id });
  await harness.store.claimCodes.updateOne(
    { _id: pending!._id },
    { $set: { codeHash: hashToken('123456') } },
  );
  await post(project, '/claim/verify', { email, code: '123456' });
}

async function operatorLink(email: string): Promise<string> {
  await harness.server.inject({
    method: 'POST',
    url: '/operator',
    payload: `email=${encodeURIComponent(email)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const record = await harness.store.operatorTokens.findOne({ email }, { sort: { createdAt: -1 } });
  const planted = `mk_test_${email.replace(/[^a-z0-9]/g, '')}`;
  await harness.store.operatorTokens.updateOne(
    { _id: record!._id },
    { $set: { hash: hashToken(planted) } },
  );
  return `/operator/${planted}`;
}

describe('a project is an instance of its own', () => {
  it('carries a name and a description that say what the board is for', async () => {
    const created = await harness.server.inject({
      method: 'POST',
      url: '/p',
      payload: {
        name: 'arbitrage-fleet',
        description: 'Six long-running loops on the arbitrage fleet.',
      },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.name, 'arbitrage-fleet');
    assert.match(body.description, /arbitrage fleet/);
    assert.match(body.board_url, /\/r\/r_.*\/board$/);

    const project: Project = {
      id: body.project,
      token: body.token,
      readUrl: body.read_url,
      api: `/v1/${body.project}`,
    };
    const renamed = await harness.server.inject({
      method: 'PATCH',
      url: project.api,
      headers: authed(project),
      payload: { description: 'Now with the scoring loop as well.' },
    });
    assert.equal(renamed.statusCode, 200);
    assert.match(renamed.json().description, /scoring loop/);
    assert.equal(renamed.json().name, 'arbitrage-fleet', 'a partial update leaves the rest alone');

    const page = await harness.server.inject({ method: 'GET', url: new URL(body.read_url).pathname });
    assert.match(page.body, /Now with the scoring loop/);
  });

  it('keeps two projects entirely apart', async () => {
    const fleet = await createProject(harness, 'fleet');
    const sygnal = await createProject(harness, 'sygnal');

    await post(fleet, '/items', { slug: 'shared-slug', title: 'fleet item', actor: 'a' });
    await post(sygnal, '/items', { slug: 'shared-slug', title: 'sygnal item', actor: 'a' });

    const fromFleet = await harness.server.inject({
      method: 'GET',
      url: `${fleet.api}/items/shared-slug`,
      headers: authed(fleet),
    });
    assert.equal(fromFleet.json().item.title, 'fleet item', 'the same slug is a different item');

    const crossed = await harness.server.inject({
      method: 'GET',
      url: `${sygnal.api}/items/shared-slug`,
      headers: authed(fleet),
    });
    assert.equal(crossed.statusCode, 403, 'one project’s token is refused by another');

    const fleetItems = await harness.store.items.countDocuments({ projectId: fleet.id });
    assert.equal(fleetItems, 1);
  });
});

describe('handing a project to its operator', () => {
  it('waits in their view until they accept, and then they own it', async () => {
    const owned = await createProject(harness, 'already mine');
    await claimFor(owned, 'boss@example.com');
    const link = await operatorLink('boss@example.com');

    const handed = await harness.server.inject({
      method: 'POST',
      url: '/p',
      payload: { name: 'new-board', description: 'created by an agent tonight' },
    });
    const project: Project = {
      id: handed.json().project,
      token: handed.json().token,
      readUrl: handed.json().read_url,
      api: `/v1/${handed.json().project}`,
    };
    await post(project, '/items', { slug: 'work', title: 'some work', actor: 'night-loop' });

    const shared = await post(project, '/share', {
      email: 'boss@example.com',
      note: 'the night run needs an owner',
      agent: 'night-loop',
    });
    assert.equal(shared.statusCode, 201);
    assert.equal(shared.json().operator_has_an_inbox, true);

    // Offered, not yet theirs.
    const before = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(before!.claimedBy, null);
    assert.ok(before!.expiresAt, 'still on the clock until somebody takes it');

    const view = await harness.server.inject({ method: 'GET', url: link });
    assert.match(view.body, /Boards handed to you/);
    assert.match(view.body, /new-board/);
    assert.match(view.body, /the night run needs an owner/);

    const offer = await harness.store.shares.findOne({ projectId: project.id });
    const accepted = await harness.server.inject({
      method: 'POST',
      url: `${link}/shares/${offer!._id}`,
      payload: 'decision=accept',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(accepted.statusCode, 303);

    const after = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(after!.claimedBy, 'boss@example.com');
    assert.equal(after!.expiresAt, null, 'accepting keeps it');
    assert.equal(after!.tier, 'free');
    assert.equal(await harness.store.shares.countDocuments({ projectId: project.id }), 0);

    const both = await harness.server.inject({ method: 'GET', url: link });
    assert.match(both.body, /new-board/);
    assert.match(both.body, /already mine/, 'both boards are now in one view');
  });

  it('can be turned down, and then it is not in the view', async () => {
    const anchor = await createProject(harness, 'anchor');
    await claimFor(anchor, 'picky@example.com');
    const link = await operatorLink('picky@example.com');

    const junk = await createProject(harness, 'not mine');
    await post(junk, '/share', { email: 'picky@example.com', agent: 'stranger' });
    const offer = await harness.store.shares.findOne({ projectId: junk.id });

    const ignored = await harness.server.inject({
      method: 'POST',
      url: `${link}/shares/${offer!._id}`,
      payload: 'decision=ignore',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(ignored.statusCode, 303);
    assert.equal(await harness.store.shares.countDocuments({ email: 'picky@example.com' }), 0);

    const after = await harness.store.projects.findOne({ _id: junk.id });
    assert.equal(after!.claimedBy, null, 'declining changes nothing about the project');
  });

  it('tells the agent when the person has no inbox to receive it', async () => {
    const project = await createProject(harness, 'orphan');
    const shared = await post(project, '/share', { email: 'stranger@example.com', agent: 'a' });
    assert.equal(shared.statusCode, 201);
    assert.equal(shared.json().operator_has_an_inbox, false);
    assert.match(shared.json().tell_them, /\/r\/r_/);
  });

  it('refuses an offer for a project somebody else already owns', async () => {
    const mine = await createProject(harness, 'mine');
    await claimFor(mine, 'first@example.com');

    const anchor = await createProject(harness, 'anchor');
    await claimFor(anchor, 'second@example.com');
    const link = await operatorLink('second@example.com');

    await harness.store.shares.insertOne({
      _id: 's_forged',
      projectId: mine.id,
      email: 'second@example.com',
      offeredBy: 'someone',
      note: '',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const attempt = await harness.server.inject({
      method: 'POST',
      url: `${link}/shares/s_forged`,
      payload: 'decision=accept',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(attempt.statusCode, 409);

    const untouched = await harness.store.projects.findOne({ _id: mine.id });
    assert.equal(untouched!.claimedBy, 'first@example.com');
  });

  it('does not double up when the same board is offered twice', async () => {
    const anchor = await createProject(harness, 'anchor');
    await claimFor(anchor, 'busy@example.com');

    const project = await createProject(harness, 'offered twice');
    await post(project, '/share', { email: 'busy@example.com', agent: 'a' });
    await post(project, '/share', { email: 'busy@example.com', agent: 'a' });
    assert.equal(
      await harness.store.shares.countDocuments({ projectId: project.id, email: 'busy@example.com' }),
      1,
    );
  });
});
