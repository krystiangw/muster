import assert from 'node:assert/strict';
import { BOARD_PRESETS, COLUMN_ITEM_LIMIT } from '../src/board.js';
import { after, before, describe, it } from 'node:test';
import { moveItem } from '../src/board.js';
import { authed, createProject, signIn, startHarness, type Harness, type Project } from './helper.js';
import { flushEvents } from '../src/events.js';
import { hashToken } from '../src/ids.js';
import { boardApplyJson } from '../src/serialize.js';
import { refreshUrl } from '../src/routes/public.js';
import { handBack } from '../src/service.js';

/**
 * Columns are a view, not a state. These tests exist to keep it that way: a
 * project can lay its board out however it likes, and no layout can introduce a
 * fifth status for every agent to learn.
 */

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

async function read(project: Project, path: string) {
  return harness.server.inject({ method: 'GET', url: `${project.api}${path}`, headers: authed(project) });
}

async function put(project: Project, path: string, payload: unknown) {
  return harness.server.inject({
    method: 'PUT',
    url: `${project.api}${path}`,
    headers: authed(project),
    payload: payload as Record<string, unknown>,
  });
}

async function board(project: Project, query = '') {
  const response = await harness.server.inject({
    method: 'GET',
    url: `${project.api}/board${query}`,
    headers: authed(project),
  });
  return response.json();
}

function cell(view: Record<string, any>, columnKey: string, rowKey = '') {
  const row = view.rows.find((candidate: { key: string }) => candidate.key === rowKey);
  return row?.columns.find((candidate: { key: string }) => candidate.key === columnKey);
}

describe('the default board', () => {
  it('separates untouched work from work somebody is holding', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'free', title: 'free', actor: 'a' });
    await post(project, '/items', { slug: 'held', title: 'held', actor: 'a' });
    await post(project, '/items', { slug: 'stuck', title: 'stuck', status: 'blocked', actor: 'a' });
    await post(project, '/items', { slug: 'shipped', title: 'shipped', status: 'done', actor: 'a' });
    await post(project, '/items/held/claim', { agent: 'worker', ttl_minutes: 30 });

    const view = await board(project);
    assert.equal(cell(view, 'todo').count, 1);
    assert.equal(cell(view, 'todo').items[0].slug, 'free');
    assert.equal(cell(view, 'doing').count, 1);
    assert.equal(cell(view, 'doing').items[0].slug, 'held');
    assert.equal(cell(view, 'blocked').count, 1);
    assert.equal(cell(view, 'done').count, 1);
    assert.equal(view.unplaced, 0);
  });

  it('treats an expired claim as free, like every other part of the system', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'lapsed', title: 'lapsed', actor: 'a' });
    await post(project, '/items/lapsed/claim', { agent: 'gone', ttl_minutes: 5 });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'lapsed' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );

    const view = await board(project);
    assert.equal(cell(view, 'doing').count, 0, 'a dead session is not somebody working');
    assert.equal(cell(view, 'todo').count, 1);
  });
});

describe('a project’s own layout', () => {
  it('puts items in columns defined by labels, without inventing a status', async () => {
    const project = await createProject(harness);
    const saved = await put(project, '/board', {
      rows: 'none',
      columns: [
        { title: 'Monitoring', match: { status: ['open'], labels: ['monitoring'] } },
        { title: 'Investigating', match: { status: ['open'], claimed: true } },
        { title: 'New', match: { status: ['open'] } },
        { title: 'Closed', match: { status: ['done', 'dropped'] } },
      ],
    });
    assert.equal(saved.statusCode, 200);

    await post(project, '/items', { slug: 'watch', title: 'watching', labels: ['monitoring'], actor: 'a' });
    await post(project, '/items', { slug: 'fresh', title: 'fresh', actor: 'a' });
    await post(project, '/items', { slug: 'busy', title: 'busy', actor: 'a' });
    await post(project, '/items/busy/claim', { agent: 'worker' });
    await post(project, '/items', { slug: 'old', title: 'old', status: 'dropped', actor: 'a' });

    const view = await board(project);
    assert.equal(cell(view, 'monitoring').items[0].slug, 'watch');
    assert.equal(cell(view, 'investigating').items[0].slug, 'busy');
    assert.equal(cell(view, 'new').items[0].slug, 'fresh');
    assert.equal(cell(view, 'closed').count, 1);

    // The statuses are still the four. The layout did not add a fifth.
    const stored = await harness.store.items.find({ projectId: project.id }).toArray();
    for (const item of stored) {
      assert.ok(['open', 'blocked', 'done', 'dropped'].includes(item.status), item.status);
    }
  });

  it('gives each item to the first matching column only', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        { title: 'Urgent', match: { priority_min: 5 } },
        { title: 'Everything else', match: {} },
      ],
    });
    await post(project, '/items', { slug: 'hot', title: 'hot', priority: 7, actor: 'a' });

    const view = await board(project);
    assert.equal(cell(view, 'urgent').count, 1);
    assert.equal(cell(view, 'everything-else').count, 0, 'a card must not appear twice');
  });

  it('reports work that matches no column instead of hiding it', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [{ title: 'Blocked only', match: { status: ['blocked'] } }],
    });
    await post(project, '/items', { slug: 'orphan', title: 'orphan', actor: 'a' });

    const view = await board(project);
    assert.equal(view.unplaced, 1);
  });

  it('lays out swimlanes by owner, with the unassigned lane last', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      rows: 'owner',
      columns: [{ title: 'Open', match: { status: ['open'] } }],
    });
    await post(project, '/items', { slug: 'a1', title: 'a1', owner: 'errors-loop', actor: 'a' });
    await post(project, '/items', { slug: 'b1', title: 'b1', owner: 'trades-loop', actor: 'a' });
    await post(project, '/items', { slug: 'c1', title: 'c1', actor: 'a' });

    const view = await board(project);
    assert.deepEqual(
      view.rows.map((row: { key: string }) => row.key),
      ['errors-loop', 'trades-loop', ''],
    );
    assert.equal(cell(view, 'open', 'errors-loop').count, 1);
    assert.equal(cell(view, 'open', '').items[0].slug, 'c1');
  });

  // The one grouping every board in this product already has, because it is in
  // the name of the card rather than in a field somebody remembered to set.
  it('lays out swimlanes by the namespace already in the slug', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      rows: 'prefix',
      columns: [{ title: 'Open', match: { status: ['open'] } }],
    });
    await post(project, '/items', { slug: 'ops:sweep', title: 'sweep', actor: 'a' });
    await post(project, '/items', { slug: 'ops:cutover', title: 'cutover', actor: 'a' });
    await post(project, '/items', { slug: 'build:pager', title: 'pager', actor: 'a' });
    await post(project, '/items', { slug: 'loose-end', title: 'loose end', actor: 'a' });

    const view = await board(project);
    assert.deepEqual(
      view.rows.map((row: { key: string }) => row.key),
      ['build', 'ops', ''],
    );
    assert.equal(cell(view, 'open', 'ops').count, 2);
    // A slug with no colon has no namespace, rather than a namespace named
    // after the whole slug, which would give every such card a lane of its own.
    assert.equal(cell(view, 'open', '').items[0].slug, 'loose-end');

    // And a card that lands in no column brings no lane either: the lane is
    // read after the column is chosen, so an area whose only work matches
    // nothing is counted above the board rather than given a row of its own.
    // Published under the board editor, so it is held here.
    // Blocked rather than done: a closed card is not scanned at all by default,
    // so it could never have been unplaced and would prove nothing here.
    await post(project, '/items', { slug: 'sec:waiting', title: 'waiting', actor: 'a' });
    await post(project, '/items', { slug: 'sec:waiting', status: 'blocked', actor: 'a' });
    const after = await board(project);
    assert.equal(after.unplaced, 1, 'the blocked card is scanned and matches no column');
    assert.ok(
      !after.rows.some((row: { key: string }) => row.key === 'sec'),
      'and brings no lane with it',
    );
  });

  it('gives one namespace a column, without anybody adding a label for it', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        { title: 'Ops', key: 'ops', match: { slug_prefix: 'ops:' } },
        { title: 'Rest', key: 'rest', match: {} },
      ],
    });
    await post(project, '/items', { slug: 'ops:sweep', title: 'sweep', actor: 'a' });
    // Carries the prefix, does not start with it. A column that took this would
    // be a search box pretending to be a boundary.
    await post(project, '/items', { slug: 'docs:ops:runbook', title: 'runbook', actor: 'a' });

    const view = await board(project);
    assert.deepEqual(
      cell(view, 'ops', '').items.map((item: { slug: string }) => item.slug),
      ['ops:sweep'],
    );
    assert.equal(cell(view, 'rest', '').count, 1);

    // Read the layout, save exactly what came back, and the column has to still
    // be the column. A filter that survives the write and not the read is one
    // that anybody editing their board deletes without being told.
    const readBack = (await board(project)).board;
    assert.equal(readBack.columns[0].match.slug_prefix, 'ops:');
    assert.equal((await put(project, '/board', readBack)).statusCode, 200);
    const again = await board(project);
    assert.equal(again.board.columns[0].match.slug_prefix, 'ops:');
    assert.deepEqual(
      cell(again, 'ops', '').items.map((item: { slug: string }) => item.slug),
      ['ops:sweep'],
    );

    const refused = await put(project, '/board', {
      columns: [{ title: 'Ops', match: { slug_prefix: '  ' } }],
    });
    assert.equal(refused.statusCode, 400);
  });

  it('filters on fields carried over from another system', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        {
          title: 'Fix planned',
          match: { fields: { legacy_status: ['fix_planned', 'root_cause_found'] } },
        },
        { title: 'Rest', match: {} },
      ],
    });
    await post(project, '/items', {
      slug: 'migrated',
      title: 'migrated',
      fields: { legacy_status: 'fix_planned' },
      actor: 'a',
    });
    await post(project, '/items', { slug: 'plain', title: 'plain', actor: 'a' });

    const view = await board(project);
    assert.equal(cell(view, 'fix-planned').items[0].slug, 'migrated');
    assert.equal(cell(view, 'rest').items[0].slug, 'plain');
  });

  it('refuses a column that tries to invent a status', async () => {
    const project = await createProject(harness);
    const rejected = await put(project, '/board', {
      columns: [{ title: 'In progress', match: { status: ['in_progress'] } }],
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /does not exist/);
  });

  it('refuses a board with no columns, duplicate keys or too many columns', async () => {
    const project = await createProject(harness);
    assert.equal((await put(project, '/board', { columns: [] })).statusCode, 400);
    assert.equal(
      (
        await put(project, '/board', {
          columns: [
            { key: 'x', title: 'One', match: {} },
            { key: 'x', title: 'Two', match: {} },
          ],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await put(project, '/board', {
          columns: Array.from({ length: 13 }, (_, i) => ({ title: `Col ${i}`, match: {} })),
        })
      ).statusCode,
      400,
    );
  });

  it('refuses two columns whose keys collide only after truncation', async () => {
    const project = await createProject(harness);
    const rejected = await put(project, '/board', {
      columns: [
        { title: 'Waiting on the exchange to confirm the transfer', match: {} },
        { title: 'Waiting on the exchange to confirm the withdrawal', match: {} },
      ],
    });
    // Both titles derive a key longer than the 32 char cut and are identical up
    // to it, so the check has to run after truncation, not before.
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /share the key/);
  });

  it('fills a catch-all column with closed work too', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'live', title: 'live', actor: 'a' });
    await post(project, '/items', { slug: 'shipped', title: 'shipped', status: 'done', actor: 'a' });
    await post(project, '/items', {
      slug: 'binned',
      title: 'binned',
      status: 'dropped',
      actor: 'a',
    });

    await put(project, '/board', {
      columns: [
        { key: 'open', title: 'Open', match: { status: ['open'] } },
        // No status filter at all: this column means "everything else", which
        // includes the two terminal statuses. Loading only open items would
        // silently render it empty.
        { key: 'rest', title: 'Everything else', match: {} },
      ],
    });

    const view = await board(project);
    assert.equal(cell(view, 'open').count, 1);
    assert.equal(cell(view, 'rest').count, 2, 'done and dropped are both in the catch-all');
    assert.deepEqual(
      cell(view, 'rest')
        .items.map((item: { slug: string }) => item.slug)
        .sort(),
      ['binned', 'shipped'],
    );
  });

  it('needs an admin token to change the layout', async () => {
    const project = await createProject(harness);
    const minted = await post(project, '/keys', { name: 'worker', role: 'write' });
    const asWorker = await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: { authorization: `Bearer ${minted.json().token}` },
      payload: { columns: [{ title: 'Mine', match: {} }] },
    });
    assert.equal(asWorker.statusCode, 403);
  });

  it('offers layouts to start from', async () => {
    const project = await createProject(harness);
    const presets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/presets`,
        headers: authed(project),
      })
    ).json();
    const keys = presets.presets.map((preset: { key: string }) => preset.key);
    assert.ok(keys.includes('loops'));
    const loops = presets.presets.find((preset: { key: string }) => preset.key === 'loops');
    assert.equal(loops.board.rows, 'owner');
  });
});

describe('the board in the browser', () => {
  it('renders columns, cards and the layout editor, and needs no JavaScript to', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'visible', title: 'a visible card', actor: 'a' });
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /a visible card/);
    assert.match(page.body, /To do/);
    assert.match(page.body, /<textarea name="board"/);

    // One script, and it is the drag: a second way to pick the column in the
    // move form that is already on every card. Everything above is here
    // without it, which is the whole shape of the thing. It is a file this
    // service serves, deferred, with no inline anything.
    const scripts = [...page.body.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    assert.equal(scripts.length, 1, `scripts on the board: ${scripts.join(' ')}`);
    assert.match(scripts[0]!, /src="\/board-[0-9a-f]{12}\.js" defer/);
    // Nothing between the tags, on any of them. A script with a `src` still
    // carries a closing tag, so the question is whether anything is written
    // between the two, and the answer has to stay no: inline is what the
    // policy above refuses and what an escaped page could otherwise smuggle.
    assert.deepEqual(
      [...page.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]),
      [''],
    );
    assert.ok(!/\son[a-z]+=/i.test(page.body), 'and no handlers in attributes either');
  });

  it('gives the drag the two names it needs, and no third source of truth', async () => {
    // The drop does not move anything itself. It picks the column in the move
    // form already on the card and submits it, so the server sees the request
    // the button makes and the rules stay in one place: the columns a card may
    // go to are that form's options, and a column outside them refuses the
    // drop rather than posting something the board would reject.
    const project = await createProject(harness, 'dragging');
    await post(project, '/items', { slug: 'draggable', title: 'a card to carry', actor: 'a' });
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });

    // The slug, and not the attribute that makes it draggable. That one is put
    // on by the script and only where a drag can happen: HTML5 drag and drop
    // has no touch equivalent, so a card marked in the markup would carry a
    // grab cursor and an affordance on a phone that cannot answer either.
    assert.match(page.body, /<article class="card"[^>]*data-slug="draggable"/);
    assert.ok(!page.body.includes('draggable="true"'), 'the markup promises no gesture');
    assert.match(page.body, /<section class="col" data-column="[a-z-]+"/);

    // Every column the markup offers as a target is a column some card's form
    // actually lists, and every draggable card has a form to submit.
    const columns = [...page.body.matchAll(/<section class="col" data-column="([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    assert.ok(columns.length >= 3, `columns: ${columns.join(', ')}`);
    const offered = new Set(
      [...page.body.matchAll(/<option value="([^"]+)" data-lands=/g)].map((match) => match[1]!),
    );
    assert.ok(
      columns.some((column) => offered.has(column)),
      'the drop targets and the form options are the same words',
    );
    // Every card the script could mark has a form for the drop to submit.
    const cards = [...page.body.matchAll(/<article class="card[^"]*"([^>]*)>/g)].map((m) => m[1]!);
    assert.ok(cards.some((one) => one.includes('data-slug=')), 'some card is a candidate');

    // A board nobody can move cards on offers no candidates at all.
    const readOnly = await harness.server.inject({ method: 'GET', url: '/' });
    assert.ok(
      !/<article class="card[^"]*"[^>]*data-slug=/.test(readOnly.body),
      'no drag where there is no move form',
    );
  });

  it('says where each card lands, on that card\u2019s own options', async () => {
    // Where a card ends up after a move is a fact about the card, not about
    // the column: a column that assigns an owner decides the lane for
    // everybody, and a column that adds a label decides it only for a card
    // that had none, or had ones that sort after it. Anything worked out from
    // the column alone is right for some cards and wrong for others, which is
    // worse than not answering, so the answer lives on each card's options.
    const project = await createProject(harness, 'swimlanes');
    await post(project, '/items', { slug: 'alex-work', title: 'work', owner: 'alex', actor: 'a' });
    await post(project, '/items', { slug: 'bob-work', title: 'more', owner: 'bob', actor: 'a' });
    await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: authed(project),
      payload: {
        rows: 'owner',
        columns: [
          { key: 'open', title: 'Open', match: { status: ['open'] } },
          { key: 'alexs', title: "Alex's", match: { status: ['open'], owner: ['alex'] } },
          { key: 'bobs', title: "Bob's", match: { status: ['open'], owner: ['bob'] } },
        ],
      },
    });
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });

    assert.match(page.body, /<div class="lane" data-lane="alex"/);
    assert.match(page.body, /<div class="lane" data-lane="bob"/);
    // The column no longer claims anything: the same column is drawn in every
    // lane and the claim was different for each card in it.
    assert.ok(!page.body.includes('data-lands=" data-column'), 'not on the column');
    assert.ok(!/<section class="col"[^>]*data-lands=/.test(page.body));

    // Split rather than match across: a lazy regex starting at the first move
    // form runs past the end of it looking for the slug, and then reads
    // options belonging to somebody else's card.
    const moveFormFor = (body: string, slug: string): string => {
      const form = body
        .split('<form class="move"')
        .slice(1)
        .find((chunk) => chunk.includes(`name="slug" value="${slug}"`));
      assert.ok(form, `${slug} has a move form`);
      return form!.slice(0, form!.indexOf('</form>'));
    };
    const optionsOf = (slug: string): Record<string, string> =>
      Object.fromEntries(
        [...moveFormFor(page.body, slug).matchAll(/<option value="([^"]+)" data-lands="([^"]*)"/g)].map(
          (match) => [match[1]!, match[2]!],
        ),
      );

    // A column that assigns somebody lands the card in that person's lane,
    // whichever card it is. A column that only sets a status leaves the card
    // where it was, which is a different answer for each of these two.
    const alexs = optionsOf('alex-work');
    const bobs = optionsOf('bob-work');
    assert.equal(alexs.bobs, 'bob', "alex's card lands in bob's lane if it goes to bob's column");
    assert.equal(bobs.alexs, 'alex');
    // Its own column is not among its options, which is why "open" is absent
    // from both: first match wins and these two cards are in it.
    // Its own column is not among its options. Both cards are drawn in "open",
    // because first match wins, so that is the one missing from each.
    assert.equal(alexs.open, undefined);
    assert.equal(bobs.open, undefined);
    // A column that assigns the owner a card already has keeps it where it is,
    // which is the case that makes this a fact about the card: the same column
    // answers "alex" for one of these and "alex" for the other too, and only
    // one of them is staying put.
    assert.equal(alexs.alexs, 'alex');
    assert.equal(bobs.alexs, 'alex');
    assert.equal(alexs.bobs, 'bob');
    assert.equal(bobs.bobs, 'bob');
  });

  it('works the label arithmetic out per card, the way the write does', async () => {
    // A lane keyed by label is the card's first label, a move unions what it
    // adds with what is already there, and the union comes back sorted. So a
    // card with no labels lands in the added one, and a card whose first label
    // sorts before it does not move lanes at all. One column, two answers.
    const project = await createProject(harness, 'labels as lanes');
    await post(project, '/items', { slug: 'bare', title: 'no labels yet', actor: 'a' });
    await post(project, '/items', { slug: 'already', title: 'has one', labels: ['aaa'], actor: 'a' });
    await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: authed(project),
      payload: {
        rows: 'label',
        columns: [
          { key: 'open', title: 'Open', match: { status: ['open'] } },
          { key: 'news', title: 'New', match: { status: ['open'], labels: ['mmm'] } },
        ],
      },
    });
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });

    const landsFor = (slug: string, column: string): string => {
      const form = page.body
        .split('<form class="move"')
        .slice(1)
        .find((chunk) => chunk.includes(`name="slug" value="${slug}"`));
      assert.ok(form, `${slug} has a move form`);
      const within = form!.slice(0, form!.indexOf('</form>'));
      return new RegExp(`<option value="${column}" data-lands="([^"]*)"`).exec(within)?.[1] ?? '(none)';
    };

    assert.equal(landsFor('bare', 'news'), 'mmm', 'a card with no labels lands in the one it gains');
    assert.equal(
      landsFor('already', 'news'),
      'aaa',
      'and a card whose first label sorts before it does not change lanes at all',
    );
  });

  it('gives every field on a card one box with its own name in it', async () => {
    // A caption above a box makes every row two rows and leaves the eye to work
    // out which caption belongs to which box. One component now: the name sits
    // inside the box it names and steps out of the way when there is something
    // in it. The placeholder is the current state and stays hidden until the
    // label has moved, because two answers in one box is worse than one.
    const project = await createProject(harness, 'one box');
    // With an owner and a label somewhere on the board, because a field only
    // offers a list when the board has values to offer: on an empty board
    // there is nothing to pick and it stays the plain input it always was.
    await post(project, '/items', {
      slug: 'shaped',
      title: 'a card with fields',
      owner: 'alex',
      labels: ['ops'],
      actor: 'a',
    });
    await post(project, '/items', { slug: 'other', title: 'something to wait on', actor: 'a' });
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=shaped`,
    });

    const sheet = /<div class="peeked open"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(page.body)?.[0] ?? page.body;
    for (const name of ['Owner', 'Add label', 'Urgency', 'Waiting on', 'Add a note']) {
      assert.match(
        sheet,
        new RegExp(`<label class="field[^"]*"[^>]*>[\\s\\S]{0,400}?<span>${name}</span>`),
        `${name} is inside its own field`,
      );
    }
    // And nothing is left carrying the old shape.
    assert.ok(
      !/<label for="(own|lab|pri|wait|note|title|body)-/.test(sheet),
      'no caption sitting above a box any more',
    );

    // The three that take a value from a list say so, and carry the values.
    for (const which of ['own', 'lab', 'wait']) {
      assert.match(sheet, new RegExp(`<input id="${which}-[^"]+"[^>]*list="list-${which}-`));
    }
    assert.match(sheet, /<datalist id="list-wait-[^"]+"><option value="other">/);
    // The one that holds several at once says which it is, so picking a value
    // replaces the word under the cursor and not the lot.
    assert.match(sheet, /<label class="field pickable" data-many="true">[\s\S]{0,200}?name="waiting"/);
  });

  it('carries no script on the pages that draw no board', async () => {
    // The board asks for it. Nowhere else does, because everywhere else it
    // would be a request that buys the reader nothing.
    for (const url of ['/', '/docs', '/pricing', '/signup', '/docs/api', '/docs/keys']) {
      const page = await harness.server.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      assert.equal(page.statusCode, 200, url);
      assert.doesNotMatch(page.body, /<script/i, url);
    }
  });

  it('saves a layout from the form and from a preset', async () => {
    const project = await createProject(harness);
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;

    const saved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board`,
      payload: `board=${encodeURIComponent(
        JSON.stringify({ rows: 'none', columns: [{ title: 'Only', match: {} }] }),
      )}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(saved.statusCode, 303);
    assert.equal((await board(project)).board.columns.length, 1);

    const preset = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board`,
      payload: 'preset=loops',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(preset.statusCode, 303);
    const view = await board(project);
    assert.equal(view.board.rows, 'owner');
    assert.ok(view.board.columns.length > 1);
  });

  it('says what is wrong instead of saving broken JSON', async () => {
    const project = await createProject(harness);
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const rejected = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board`,
      payload: 'board=not json at all',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /valid JSON/);
  });
});

describe('moving an item into a column', () => {
  async function move(project: Project, slug: string, column: string, actor = 'mover') {
    return harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/${slug}/move`,
      headers: authed(project),
      payload: { column, actor },
    });
  }

  it('takes a finished card back into progress, which is one operation', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items', { slug: 'work', status: 'done', actor: 'a' });

    // Dragging a done card into the in-progress column reopens it and claims
    // it, and the claim goes first because it is the half most likely to fail
    // on somebody else's account. Finished work refuses a lease, and this is
    // the one caller that carries the card through that refusal: the same call
    // is about to write the status that ends it.
    const back = await move(project, 'work', 'doing', 'worker');
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().landed_in, 'doing');
    assert.equal(back.json().item.status, 'open');
    assert.equal(back.json().item.claim.agent, 'worker');
  });

  it('refuses it into a column that claims without reopening anything', async () => {
    const project = await createProject(harness);
    const laid = await harness.server.inject({
      method: 'PUT',
      url: `${project.api}/board`,
      headers: authed(project),
      payload: {
        columns: [
          { key: 'busy', title: 'Somebody is on it', match: { claimed: true } },
          { key: 'rest', title: 'The rest', match: { status: ['open'] } },
        ],
      },
    });
    assert.equal(laid.statusCode, 200, laid.body);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    await post(project, '/items', { slug: 'work', status: 'done', actor: 'a' });

    // The escape hatch above is exactly as wide as the reopen. A column that
    // only claims would show finished work as somebody's work in progress,
    // which is the thing the refusal exists to stop.
    const refused = await move(project, 'work', 'busy', 'worker');
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'already_finished');
    const after = await harness.store.items.findOne({ projectId: project.id, slug: 'work' });
    assert.equal(after?.claim, null, 'and the refused move holds nothing');
    assert.equal(after?.status, 'done');
  });

  it('reads the default board as claim, release and status', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });

    const started = await move(project, 'work', 'doing', 'worker');
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().landed_in, 'doing');
    assert.equal(started.json().item.claim.agent, 'worker', 'in progress is a claim, not a status');
    assert.equal(started.json().item.status, 'open', 'and no fifth status was invented');

    const back = await move(project, 'work', 'todo');
    assert.equal(back.json().landed_in, 'todo');
    assert.equal(back.json().item.claim, null);

    const finished = await move(project, 'work', 'done');
    assert.equal(finished.json().landed_in, 'done');
    assert.equal(finished.json().item.status, 'done');
  });

  it('adds and removes the labels its column filters on', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'signal',
      title: 'signal',
      labels: ['triage'],
      actor: 'a',
    });
    await put(project, '/board', {
      columns: [
        { key: 'triage', title: 'Triage', match: { labels: ['triage'] } },
        {
          key: 'watching',
          title: 'Watching',
          match: { labels: ['monitoring'], not_labels: ['triage'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    const moved = await move(project, 'signal', 'watching');
    assert.equal(moved.json().landed_in, 'watching');
    assert.deepEqual(moved.json().item.labels, ['monitoring']);
    assert.deepEqual(moved.json().applied, {
      add_labels: ['monitoring'],
      remove_labels: ['triage'],
    });
  });

  it('honours an apply the column spells out', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'escalated', title: 'escalated', actor: 'a' });
    await put(project, '/board', {
      columns: [
        {
          key: 'operator',
          title: 'Waiting on the operator',
          match: { status: ['blocked'], labels: ['operator'] },
          apply: { status: 'blocked', add_labels: ['operator'], owner: 'alex', priority: 3 },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    const moved = await move(project, 'escalated', 'operator');
    assert.equal(moved.json().landed_in, 'operator');
    assert.equal(moved.json().item.owner, 'alex');
    assert.equal(moved.json().item.priority, 3);
    assert.equal(moved.json().item.status, 'blocked');
    assert.ok(moved.json().item.labels.includes('operator'));
  });

  it('says so when the item does not land where it was sent', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'partial', title: 'partial', actor: 'a' });
    await put(project, '/board', {
      // The column wants a label and a source; a move can set the label but
      // never invents where an item came from.
      columns: [
        {
          key: 'mirrored',
          title: 'Mirrored',
          match: { labels: ['mirror'], source: ['scanner'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    const moved = await move(project, 'partial', 'mirrored');
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().landed_in, 'rest');
    assert.match(moved.json().warning, /not "mirrored"/);
  });

  it('refuses a column that has nothing to apply, and one that does not exist', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'thing', title: 'thing', actor: 'a' });
    await put(project, '/board', {
      columns: [
        { key: 'everything', title: 'Everything', match: {} },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    });

    const pointless = await move(project, 'thing', 'everything');
    assert.equal(pointless.statusCode, 400);
    assert.match(pointless.json().message, /nothing to apply/);

    const missing = await move(project, 'thing', 'nowhere');
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().message, /everything, done/, 'it names the columns it does have');
  });

  it('refuses to take an item somebody else is holding', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'busy', title: 'busy', actor: 'a' });
    await post(project, '/items/busy/claim', { agent: 'first', ttl_minutes: 30 });

    const stolen = await move(project, 'busy', 'doing', 'second');
    assert.equal(stolen.statusCode, 409);
    assert.match(stolen.json().message, /held by first/);

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'busy' });
    assert.equal(item!.claim!.agent, 'first', 'and nothing was changed on the way');
  });

  it('keeps the layout’s move semantics when the layout is read back and saved', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [
        {
          key: 'monitoring',
          title: 'Monitoring',
          match: { labels: ['monitoring'] },
          apply: { add_labels: ['monitoring'], release: true },
        },
      ],
    });

    const read = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board`,
        headers: authed(project),
      })
    ).json().board;
    assert.deepEqual(read.columns[0].apply, { add_labels: ['monitoring'], release: true });

    // Read, then written back unchanged: the round trip must not erase it,
    // which is exactly what the settings form does every time it saves.
    const saved = await put(project, '/board', read);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().board.columns[0].apply, {
      add_labels: ['monitoring'],
      release: true,
    });
  });

  it('does not leave a lease behind on a move it refuses', async () => {
    const isolated = await startHarness();
    try {
      const project = await createProject(isolated, 'full');
      const write = (path: string, payload: unknown) =>
        isolated.server.inject({
          method: 'POST',
          url: `${project.api}${path}`,
          headers: authed(project),
          payload: payload as Record<string, unknown>,
        });

      // Fill the project to its cap, then close one item so there is something
      // to move back in without a slot to put it in.
      const limits = (await isolated.store.projects.findOne({ _id: project.id }))!.limits.items;
      for (let index = 0; index < limits; index += 1) {
        await write('/items', { slug: `fill-${index}`, title: 'fill', actor: 'a' });
      }
      await write('/items', { slug: 'fill-0', title: 'fill', status: 'done', actor: 'a' });
      for (let index = limits; index < limits + 1; index += 1) {
        await write('/items', { slug: `fill-${index}`, title: 'fill', actor: 'a' });
      }

      const refused = await write('/items/fill-0/move', { column: 'doing', actor: 'worker' });
      // 409, like every other way of meeting this cap: it is a conflict with
      // what the board holds, not a request to slow down.
      assert.equal(refused.statusCode, 409, 'reopening at the cap is refused');
      // Which 409, because a second one now answers this door: a lease is not
      // handed out over finished work, and a test reading only the status
      // would pass on the wrong refusal.
      assert.equal(refused.json().error, 'limit_reached');

      const item = await isolated.store.items.findOne({ projectId: project.id, slug: 'fill-0' });
      assert.equal(item!.claim, null, 'and the refused move holds nothing');
      assert.equal(item!.status, 'done', 'and changed nothing');
    } finally {
      await isolated.stop();
    }
  });

  it('keeps a label another writer added while the move was in flight', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'shared', title: 'shared', labels: ['triage'], actor: 'a' });
    await put(project, '/board', {
      columns: [
        {
          key: 'watching',
          title: 'Watching',
          match: { labels: ['monitoring'] },
          apply: { add_labels: ['monitoring'], remove_labels: ['triage'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    // Somebody adds an unrelated label after the move read the item. Computing
    // the whole array from a snapshot would drop it.
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'shared' },
      { $push: { labels: 'urgent' } },
    );

    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/shared/move`,
      headers: authed(project),
      payload: { column: 'watching', actor: 'mover' },
    });
    const labels = moved.json().item.labels as string[];
    assert.ok(labels.includes('monitoring'), 'the move added its own label');
    assert.ok(!labels.includes('triage'), 'and removed its own');
    assert.ok(labels.includes('urgent'), 'and left the other writer’s alone');
  });

  it('reports an item deleted mid-move as gone instead of recreating it', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'vanishing', title: 'vanishing', actor: 'a' });
    await harness.store.items.deleteOne({ projectId: project.id, slug: 'vanishing' });

    const moved = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/vanishing/move`,
      headers: authed(project),
      payload: { column: 'done', actor: 'mover' },
    });
    assert.equal(moved.statusCode, 404);
    assert.equal(
      await harness.store.items.countDocuments({ projectId: project.id, slug: 'vanishing' }),
      0,
      'a blank item was not conjured in its place',
    );
  });

  /**
   * A move is several writes, and the interesting failures happen between them.
   * That interleaving cannot be produced from outside the process, so these
   * tests hand the move a store that lets somebody else in after the nth call
   * of one method. The seam is in the test, never in the product.
   */
  function storeThatInterrupts(after: { call: string; nth: number }, meddle: () => Promise<void>) {
    let seen = 0;
    const items = new Proxy(harness.store.items, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== after.call) {
          return typeof value === 'function' ? (value as Function).bind(target) : value;
        }
        return async (...args: unknown[]) => {
          const result = await (value as Function).apply(target, args);
          seen += 1;
          if (seen === after.nth) await meddle();
          return result;
        };
      },
    });
    return { ...harness.store, items };
  }

  async function projectDoc(project: Project) {
    return (await harness.store.projects.findOne({ _id: project.id }))!;
  }

  it('does not revoke a claim taken after it read the item', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'contested', title: 'contested', actor: 'a' });
    await post(project, '/items/contested/claim', { agent: 'first', ttl_minutes: 30 });

    // The previous lease expired and another agent picked the work up, in the
    // instant after the move read the item.
    const store = storeThatInterrupts({ call: 'findOne', nth: 1 }, async () => {
      await harness.store.items.updateOne(
        { projectId: project.id, slug: 'contested' },
        {
          $set: {
            claim: {
              agent: 'second',
              claimedAt: new Date(),
              heartbeatAt: new Date(),
              expiresAt: new Date(Date.now() + 1_800_000),
            },
          },
        },
      );
    });

    const result = await moveItem(store, await projectDoc(project), {
      slug: 'contested',
      column: 'todo',
      actor: 'mover',
    });

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'contested' });
    assert.equal(item!.claim?.agent, 'second', 'the newer holder keeps the item');
    assert.equal(result.landedIn, 'doing', 'and the board says where it really is');
  });

  it('reports an item deleted between the write and the labels as gone', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'doomed', title: 'doomed', actor: 'a' });
    await put(project, '/board', {
      columns: [
        {
          key: 'watching',
          title: 'Watching',
          match: { labels: ['monitoring'] },
          apply: { add_labels: ['monitoring'] },
        },
        { key: 'rest', title: 'Rest', match: {} },
      ],
    });

    // Deleted after the item was written and before its labels were applied.
    // Answering 200 here would put a card on the board for an item that is gone.
    const store = storeThatInterrupts({ call: 'findOneAndUpdate', nth: 1 }, async () => {
      await harness.store.items.deleteOne({ projectId: project.id, slug: 'doomed' });
    });

    await assert.rejects(
      moveItem(store, await projectDoc(project), {
        slug: 'doomed',
        column: 'watching',
        actor: 'mover',
      }),
      (error: { statusCode?: number; code?: string }) =>
        error.statusCode === 404 && error.code === 'not_found',
    );
  });

  it('lets a column show only what was touched lately', async () => {
    // The Done column grows for ever, and finished work is still worth reading:
    // it is how an agent finds out something was already tried. So the answer is
    // a view, not a delete and not a fifth status.
    const project = await createProject(harness, 'landfill');
    await put(project, '/board', {
      columns: [
        { key: 'open', title: 'Open', match: { status: ['open'] } },
        { key: 'done', title: 'Recently done', match: { status: ['done'], within_days: 14 } },
      ],
    });
    for (const [slug, days] of [
      ['fresh', 1],
      ['ancient', 90],
    ] as const) {
      await post(project, '/items', {
        slug,
        title: slug,
        status: 'done',
        actor: slug === 'ancient' ? 'ancient-only' : 'a',
      });
      await harness.store.items.updateOne(
        { projectId: project.id, slug },
        { $set: { updatedAt: new Date(Date.now() - days * 86_400_000) } },
      );
    }

    const board = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board`,
        headers: authed(project),
      })
    ).json();
    const done = board.totals.find((column: { key: string }) => column.key === 'done');
    assert.equal(done.count, 1, 'only the recent one is on the board');

    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /fresh/);
    assert.ok(!page.body.includes('ancient'), 'the old one is off the board, not gone');

    // Off the board and still in the project, which is the whole difference
    // between a view and a delete.
    const items = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items?status=done`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(
      items.items.map((item: { slug: string }) => item.slug).sort(),
      ['ancient', 'fresh'],
    );

    // The window bounds the query, not the page. The scan takes the most urgent
    // thousand, so old finished work ahead of a recent card in that order would
    // fill it and leave the column empty while the item it wanted sat unread.
    const explained = await harness.store.items
      .find({ projectId: project.id, status: 'done', updatedAt: { $lt: new Date(Date.now() - 14 * 86_400_000) } })
      .toArray();
    assert.equal(explained.length, 1, 'the old one is still in the collection');

    // The filters offered are the ones the board can still answer.
    const facets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    assert.ok(!facets.agents.includes('ancient-only'), 'nothing that only expired work carries');

    // Narrowing by agent must not undo the window. Both are conditions, and a
    // second one written over the first is how a bounded scan quietly stops
    // being bounded.
    const byAgent = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board?agent=ancient-only`,
        headers: authed(project),
      })
    ).json();
    assert.equal(
      byAgent.totals.find((column: { key: string }) => column.key === 'done').count,
      0,
      'the expired card stays off the board, filtered or not',
    );

    // And the layout carries it back out, in the same words it went in.
    const again = await put(project, '/board', {
      columns: [
        { key: 'open', title: 'Open', match: { status: ['open'] } },
        { key: 'done', title: 'Recently done', match: { status: ['done'], within_days: 14 } },
      ],
    });
    assert.equal(again.json().board.columns[1].match.within_days, 14);
  });

  it('keeps up with the agents without being asked to', async () => {
    // A board is written to by loops while somebody is looking at it, so a page
    // that only changes when a person presses something is a page that is wrong
    // most of the time. Asking them to opt into being told the truth was asking
    // the wrong question, and the switch that asked it is gone.
    const project = await createProject(harness, 'watched');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'card', title: 'card', actor: 'a' },
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    // Still every minute, and now naming where it goes: the reload the page
    // asks for is marked so it is not counted as somebody arriving to read it.
    assert.match(page.body, /<meta http-equiv="refresh" content="60; url=[^"]*refreshed=1[^"]*">/);
    assert.ok(!page.body.includes('name="live"'), 'and nothing to switch');
  });

  it('files a card from the board, and never on top of one already there', async () => {
    // Asked in a browser: there was no way to add an item except curl. Nobody
    // decided that a person may not file work, it was never built.
    const project = await createProject(harness, 'filing');
    const readToken = project.readUrl.split('/r/')[1]!;
    const file = (title: string, body = '') =>
      harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}/board/new`,
        payload: `title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });

    const first = await file('Check the bridge fee', 'the venue keeps quoting two numbers');
    assert.equal(first.statusCode, 303);
    assert.match(first.headers.location as string, /done=check-the-bridge-fee/);
    const item = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'check-the-bridge-fee',
    });
    assert.equal(item?.title, 'Check the bridge fee');
    assert.equal(item?.status, 'open');
    assert.equal(item?.lastActor, 'operator');

    // The same words a week later are a second piece of work, not an edit of
    // the first: a slug derived from a title must not land on top of a card
    // somebody else is holding.
    const second = await file('Check the bridge fee', 'again, on the other venue');
    assert.match(second.headers.location as string, /done=check-the-bridge-fee-2/);
    assert.equal(
      await harness.store.items.countDocuments({ projectId: project.id }),
      2,
      'two cards, not one rewritten',
    );
    const kept = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'check-the-bridge-fee',
    });
    assert.equal(kept?.body, 'the venue keeps quoting two numbers', 'the first is untouched');

    // A title is the one thing it cannot do without.
    const empty = await file('   ');
    assert.equal(empty.statusCode, 400);

    // Filed at the same instant, both keep their words. The lookup cannot see
    // that race; the write settles it, and the loser gets another name.
    const together = await Promise.all([file('Same words', 'mine'), file('Same words', 'theirs')]);
    assert.deepEqual(
      together.map((response) => response.statusCode),
      [303, 303],
    );
    const both = await harness.store.items
      .find({ projectId: project.id, slug: { $regex: '^same-words' } })
      .toArray();
    assert.equal(both.length, 2, 'two cards');
    assert.deepEqual(
      both.map((item) => item.body).sort(),
      ['mine', 'theirs'],
      'and neither wrote over the other',
    );

    // And the form is on the page that files it, behind the link that opens
    // it: the sheet is an address now, so the board can stop reloading itself
    // under whoever is typing into one.
    const closed = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.ok(
      !closed.body.includes(`action="/r/${readToken}/board/new"`),
      'not until it is asked for',
    );
    assert.match(closed.body, /http-equiv="refresh"/, 'and the board keeps itself true meanwhile');

    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?new=1`,
    });
    assert.match(page.body, new RegExp(`action="/r/${readToken}/board/new"`));
    assert.ok(!page.body.includes('http-equiv="refresh"'), 'and holds still while it is open');
  });

  it('carries a question on the card it was asked about, answerable there', async () => {
    // Reported from a browser: a card that something is waiting on showed the
    // work and no way to reply. The question lived on the other page, and
    // finding it meant knowing it existed.
    const project = await createProject(harness, 'asked about');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'bridge', title: 'the bridge', actor: 'errors-loop' },
    });
    const asked = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: {
        agent: 'errors-loop',
        question: 'Do we pay the bridge fee?',
        item_slug: 'bridge',
      },
    });
    const id = asked.json().escalation.id;
    const readToken = project.readUrl.split('/r/')[1]!;

    // The face of the card says something is waiting, before anybody opens it:
    // a board whose claim is "what needs a human" cannot hide that one card
    // deep.
    const face = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(face.body, /<span class="chip asks">asks you<\/span>/);

    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=bridge`,
    });
    assert.match(page.body, /Do we pay the bridge fee\?/, 'the question is on the card');
    assert.match(page.body, new RegExp(`action="/r/${readToken}/escalations/${id}"`));

    const answered = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/escalations/${id}`,
      payload: 'status=answered&answer=yes%2C+pay+it&back=board',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(answered.statusCode, 303);
    assert.equal(
      answered.headers.location,
      `/r/${readToken}/board?answered=${id}`,
      'and it comes back to the board it was answered from',
    );

    const doc = await harness.store.escalations.findOne({ _id: id });
    assert.equal(doc?.status, 'answered');
    assert.equal(doc?.answer, 'yes, pay it');

    // And the board it lands on says so, from the stored question rather than
    // from the URL: four buttons that look alike and a silent reload is how
    // somebody answers the same thing twice.
    const landed = await harness.server.inject({
      method: 'GET',
      url: answered.headers.location as string,
    });
    assert.match(landed.body, /Answered\. errors-loop picks it up/);

    // Answered, so the card stops asking. The question stays in the timeline,
    // where it belongs: what was asked and what was decided is the history of
    // the work, and only the form goes away.
    const after = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=bridge`,
    });
    assert.ok(
      !after.body.includes(`action="/r/${readToken}/escalations/${id}"`),
      'the form is gone',
    );
    assert.match(after.body, /asked the operator: Do we pay the bridge fee\?/, 'the record stays');
  });

  it('shows every open question on a card, not the last one read', async () => {
    // Two agents can be waiting on one item. Keyed by slug, one of them would
    // wait invisibly until the other was answered.
    const project = await createProject(harness, 'two waiting');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'shared', title: 'the shared one', actor: 'a' },
    });
    for (const [agent, question] of [
      ['errors-loop', 'Do we pay the fee?'],
      ['pm-loop', 'Do we tell the venue first?'],
    ]) {
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/escalations`,
        headers: authed(project),
        payload: { agent, question, item_slug: 'shared' },
      });
    }

    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=shared`,
    });
    assert.match(page.body, /<span class="chip asks">2 questions<\/span>/, 'and the card counts them');
    assert.match(page.body, /Do we pay the fee\?/);
    assert.match(page.body, /Do we tell the venue first\?/);
  });

  it('keeps the narrowing when a question is answered from a filtered board', async () => {
    const project = await createProject(harness, 'narrowed answer');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'card', title: 'card', owner: 'alex', actor: 'a' },
    });
    const asked = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/escalations`,
      headers: authed(project),
      payload: { agent: 'a', question: 'Which one?', item_slug: 'card' },
    });
    const id = asked.json().escalation.id;
    const readToken = project.readUrl.split('/r/')[1]!;

    const answered = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/escalations/${id}`,
      payload: 'status=answered&answer=this+one&back=board&from_owner=alex&from_q=card',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const location = answered.headers.location as string;
    assert.match(location, /owner=alex/, 'the board comes back as it was being read');
    assert.match(location, /q=card/);
  });

  it('merges two spellings of one agent from the page that shows both', async () => {
    // The API has had this since the warnings did. The person reading the
    // filter is the one who notices two spellings, and sending them to curl to
    // fix what they are looking at is how a board keeps both.
    const project = await createProject(harness, 'two names');
    for (const [slug, actor] of [
      ['one', 'trades-loop'],
      ['two', 'trades_loop'],
      // The person's own door, typed by an agent that shouted it. It is not a
      // spelling of anything, so it is never one of the two names on offer.
      ['three', 'Operator'],
    ] as const) {
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug, title: slug, actor },
      });
    }
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, new RegExp(`action="/r/${readToken}/board/agent-rename"`));
    assert.match(page.body, /trades_loop \(seen, not registered\)/);
    const merge = page.body.slice(page.body.indexOf('/board/agent-rename'));
    assert.ok(
      !merge.slice(0, merge.indexOf('</form>')).includes('value="Operator"'),
      'the door is not a name to consolidate, however it was typed',
    );

    const merged = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/agent-rename`,
      payload: 'from=trades_loop&to=trades-loop&from_owner=alex',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(merged.statusCode, 303);
    assert.match(
      merged.headers.location as string,
      /owner=alex/,
      'and it comes back to the board as it was being read',
    );

    const after = await harness.server.inject({
      method: 'GET',
      url: merged.headers.location as string,
    });
    assert.match(
      after.body,
      /&quot;trades_loop&quot; is now &quot;trades-loop&quot; here\. Everything it wrote last/,
    );

    // The sentence is the board's, not the URL's: a crafted link naming a merge
    // that never happened says nothing at all.
    const crafted = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?merged=somebody>anybody`,
    });
    assert.ok(!crafted.body.includes('is now'), 'nothing a link can put on this page');
    assert.equal(
      (await harness.store.items.findOne({ projectId: project.id, slug: 'two' }))?.lastActor,
      'trades-loop',
    );

    // One name in the filter now, and the control is gone with the reason for
    // it: nothing left to choose between.
    assert.ok(!after.body.includes('trades_loop (seen, not registered)'));
  });

  it('opens a card the column stopped drawing, and keeps holding the refresh', async () => {
    // A card sheet is a link somebody can send now. A column draws its first
    // fifteen cards, so work filed above it between sending the link and
    // opening it used to leave the address opening nothing at all, silently,
    // and the page went back to reloading under whoever was typing.
    const project = await createProject(harness, 'deep card');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/agents`,
      headers: authed(project),
      payload: { handle: 'deep-loop', scope: [], description: 'watches the slow venue' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'buried', title: 'the buried one', priority: -5, actor: 'deep-loop' },
    });
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items/buried/timeline`,
      headers: authed(project),
      payload: { actor: 'deep-loop', message: 'the venue answered on the second try' },
    });
    // Past what a column keeps, not only past what it draws: fifty items are
    // held per cell, and a link older than that is exactly the one somebody
    // sends and opens a week later.
    for (let n = 0; n < COLUMN_ITEM_LIMIT + 2; n += 1) {
      await harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug: `newer-${n}`, title: `newer ${n}`, priority: 5, actor: 'a' },
      });
    }
    const readToken = project.readUrl.split('/r/')[1]!;

    const closed = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.ok(!closed.body.includes('the buried one'), 'the column stopped drawing it');

    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=buried`,
    });
    assert.match(page.body, /the buried one/, 'the address still opens it');
    assert.match(page.body, /the venue answered on the second try/, 'with its history');
    assert.match(
      page.body,
      /title="watches the slow venue"/,
      'and with what the agent on it is for, like every other sheet',
    );
    assert.ok(!page.body.includes('http-equiv="refresh"'), 'and the page holds still');
  });

  it('lets a person correct the words on a card, and never blank the title by accident', async () => {
    const project = await createProject(harness, 'wording');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'card', title: 'teh bridge', body: 'first draft', actor: 'errors-loop' },
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const edited = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/edit`,
      payload:
        'slug=card&title=The+bridge&body=second+draft%2C+with+the+numbers&was_title=teh+bridge&was_body=first+draft',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(edited.statusCode, 303);
    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'card' });
    assert.equal(item?.title, 'The bridge');
    assert.equal(item?.body, 'second draft, with the numbers');
    assert.match(item!.timeline.at(-1)!.message, /edited from the board/, 'the record says so');
    assert.equal(item!.timeline.at(-1)!.by, 'operator');

    // A blank title is a stray select-all, not an instruction to leave a card
    // nobody can read. A blank description is rarer and is taken literally.
    const blanked = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/edit`,
      payload:
        'slug=card&title=&body=&was_title=The+bridge&was_body=second+draft%2C+with+the+numbers',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(blanked.statusCode, 303);
    const after = await harness.store.items.findOne({ projectId: project.id, slug: 'card' });
    assert.equal(after?.title, 'The bridge', 'the title survives');
    assert.equal(after?.body, '', 'and the description was cleared on purpose');

    // An agent writing while the form was open keeps its words: only what this
    // person changed is written, and a field they did change that moved
    // underneath them is refused rather than overwritten.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'card', body: 'the agent learned something new', actor: 'errors-loop' },
    });
    const onlyTitle = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/edit`,
      payload: 'slug=card&title=The+bridge+fee&body=&was_title=The+bridge&was_body=',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(onlyTitle.statusCode, 303);
    const kept = await harness.store.items.findOne({ projectId: project.id, slug: 'card' });
    assert.equal(kept?.title, 'The bridge fee');
    assert.equal(kept?.body, 'the agent learned something new', 'the agent keeps its words');

    const stale = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/edit`,
      payload: 'slug=card&title=The+bridge+fee&body=my+older+copy&was_title=The+bridge+fee&was_body=',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'changed_underneath');
    assert.equal(
      (await harness.store.items.findOne({ projectId: project.id, slug: 'card' }))?.body,
      'the agent learned something new',
      'and nothing was saved',
    );

    // A guard is a statement about a card that exists, so it never files one,
    // and it never carries a status: the transition has its own guard, and the
    // two arriving together would move the card and then refuse the edit.
    const { upsertItem } = await import('../src/service.js');
    const projectDoc = (await harness.store.projects.findOne({ _id: project.id }))!;
    await assert.rejects(
      upsertItem(harness.store, projectDoc, {
        slug: 'card',
        title: 'x',
        status: 'done',
        expect: { title: 'The bridge fee' },
        actor: 'operator',
      }),
      (error: { statusCode?: number; code?: string }) =>
        error.statusCode === 400 && error.code === 'guarded_status',
    );
    await assert.rejects(
      upsertItem(harness.store, projectDoc, {
        slug: 'never-filed',
        title: 'x',
        expect: { title: 'something' },
        actor: 'operator',
      }),
      (error: { statusCode?: number }) => error.statusCode === 404,
    );
    assert.equal(
      await harness.store.items.countDocuments({ projectId: project.id, slug: 'never-filed' }),
      0,
      'a guarded write files nothing',
    );

    // The form is on the card, and it is folded shut: an edit replaces part of
    // the record, and a note adds to it.
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=card`,
    });
    assert.match(page.body, new RegExp(`action="/r/${readToken}/board/edit"`));
    assert.match(page.body, /<summary>Edit the words<\/summary>/);
  });

  it('lets a person say how urgent, filing it and afterwards', async () => {
    // Filing existed and prioritising did not, so a card a person asked for sat
    // behind everything the agents had filed at +5: /next offers by priority.
    const project = await createProject(harness, 'urgency');
    const readToken = project.readUrl.split('/r/')[1]!;

    const filed = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/new`,
      payload: 'title=Call+the+venue&body=they+quote+two+numbers&priority=5',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(filed.statusCode, 303);
    const item = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'call-the-venue',
    });
    assert.equal(item?.priority, 5, 'filed as urgent');

    // And it is what an agent is handed next, which is the whole point.
    const next = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/next?agent=any-loop`,
        headers: authed(project),
      })
    ).json();
    assert.equal(next.item.slug, 'call-the-venue');

    // Changed afterwards, from the card.
    const lowered = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/priority`,
      payload: 'slug=call-the-venue&priority=-3',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(lowered.statusCode, 303);
    const after = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'call-the-venue',
    });
    assert.equal(after?.priority, -3);
    assert.match(after!.timeline.at(-1)!.message, /urgency set to -3/, 'and it says who changed it');
    assert.equal(after!.timeline.at(-1)!.by, 'operator');

    // Nonsense is refused rather than stored, and a typo is not a decision:
    // parseInt would read "2.9" as 2 and "5junk" as 5.
    // And what this service prints is what it accepts: urgency reads as "+5"
    // on every page, so posting it back cannot be a 400.
    const signed = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/priority`,
      payload: 'slug=call-the-venue&priority=%2B2',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(signed.statusCode, 303);
    assert.equal(
      (await harness.store.items.findOne({ projectId: project.id, slug: 'call-the-venue' }))
        ?.priority,
      2,
    );
    await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/priority`,
      payload: 'slug=call-the-venue&priority=-3',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    for (const bad of ['99', '2.9', '5junk', '', 'urgent']) {
      const nonsense = await harness.server.inject({
        method: 'POST',
        url: `/r/${readToken}/board/priority`,
        payload: `slug=call-the-venue&priority=${encodeURIComponent(bad)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      assert.equal(nonsense.statusCode, 400, `priority=${bad}`);
    }
    const untouched = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'call-the-venue',
    });
    assert.equal(untouched?.priority, -3, 'and none of them changed it');

    // An item an agent filed off the four points keeps its own number, and the
    // control shows it rather than the first option, which pressing "set"
    // beside would have silently applied.
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'from-a-loop', title: 'filed at seven', priority: 7, actor: 'a' },
    });
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=from-a-loop`,
    });
    assert.match(page.body, /<option value="7" selected>\+7<\/option>/);

    // Filing without one is ordinary work, the same as an agent filing without
    // one, so the two doors agree on the same silence.
    await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/new`,
      payload: 'title=Something+else',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const plain = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'something-else',
    });
    assert.equal(plain?.priority, 0);
  });

  it('lets a person write a note into the timeline the agents read', async () => {
    // Reported from a browser: opening a card offered assign, tag and move, and
    // nowhere to say why. A board a person may only rearrange is not shared.
    const project = await createProject(harness, 'two way');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'card', title: 'card', actor: 'errors-loop' },
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const posted = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/note`,
      payload: 'slug=card&message=the+venue+replied%2C+it+is+their+bridge',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(posted.statusCode, 303);

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'card' });
    const last = item!.timeline.at(-1)!;
    assert.equal(last.by, 'operator', 'a human sentence is signed as one');
    assert.match(last.message, /the venue replied/);

    // And it is on the page the agents and the person both read.
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=card`,
    });
    assert.match(page.body, /the venue replied, it is their bridge/);

    // An empty note is a slip of the hand, not an instruction to file a blank
    // line into a timeline everybody reads.
    const empty = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/note`,
      payload: 'slug=card&message=+++',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(empty.statusCode, 303);
    const after = await harness.store.items.findOne({ projectId: project.id, slug: 'card' });
    assert.equal(after!.timeline.length, item!.timeline.length, 'nothing was written');
  });

  it('rate limits reads through a read link too, since one of them is a search', async () => {
    // The API door counts what one token may read in a minute; these two pages
    // counted nothing, and one of them carries a search box whose worst case is
    // a pass over the whole collection. Same capability, same ceiling.
    const isolated = await startHarness({ LIMIT_READS_PER_MINUTE: '2' });
    try {
      const project = await createProject(isolated, 'read often');
      const readToken = project.readUrl.split('/r/')[1]!;
      const read = () =>
        isolated.server.inject({
          method: 'GET',
          url: `/r/${readToken}/board`,
          headers: { 'x-forwarded-for': '203.0.113.7' },
        });

      assert.equal((await read()).statusCode, 200);
      assert.equal((await read()).statusCode, 200);
      const third = await read();
      assert.equal(third.statusCode, 429);
      assert.ok(third.headers['retry-after'], 'and it says when to come back');

      // The board and the page beside it share the ceiling, because they share
      // the link: counting them apart would double what the link is allowed.
      const beside = await isolated.server.inject({
        method: 'GET',
        url: `/r/${readToken}`,
        headers: { 'x-forwarded-for': '203.0.113.8' },
      });
      assert.equal(beside.statusCode, 429, 'from another address too: the ceiling is the link');
    } finally {
      await isolated.stop();
    }
  });

  it('does not let a link that no longer opens anything spend the owner budget', async () => {
    // A project narrowed to its owner refuses the old link. Charged before that
    // is decided, whoever kept the link could hold the bucket empty for ever,
    // and the owner, signed in and entitled, would meet a wall put up by
    // somebody already locked out.
    const isolated = await startHarness({ LIMIT_READS_PER_MINUTE: '2' });
    try {
      const project = await createProject(isolated, 'narrowed later');
      const readToken = project.readUrl.split('/r/')[1]!;
      const email = 'owner@example.com';
      await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/claim`,
        headers: authed(project),
        payload: { email },
      });
      const pending = await isolated.store.claimCodes.findOne({ projectId: project.id, email });
      await isolated.store.claimCodes.updateOne(
        { _id: pending!._id },
        { $set: { codeHash: hashToken('123456') } },
      );
      await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/claim/verify`,
        headers: authed(project),
        payload: { email, code: '123456' },
      });
      await isolated.server.inject({
        method: 'PATCH',
        url: project.api,
        headers: authed(project),
        payload: { visibility: 'owner' },
      });

      const stale = () =>
        isolated.server.inject({
          method: 'GET',
          url: `/r/${readToken}/board`,
          headers: { 'x-forwarded-for': '198.51.100.4' },
        });
      assert.equal((await stale()).statusCode, 404);
      assert.equal((await stale()).statusCode, 404);
      // The third is refused for asking too often from one address, which is
      // the ceiling on handing out refusals rather than the owner's allowance.
      assert.equal((await stale()).statusCode, 429);

      const session = await signIn(isolated, email);
      const owner = await isolated.server.inject({
        method: 'GET',
        url: `/r/${readToken}/board`,
        headers: { cookie: session.cookie, 'x-forwarded-for': '198.51.100.9' },
      });
      assert.equal(owner.statusCode, 200, 'the owner still has their whole budget');
    } finally {
      await isolated.stop();
    }
  });

  it('rate limits writes through a read link, which is a shareable capability', async () => {
    const isolated = await startHarness({ LIMIT_WRITES_PER_MINUTE: '2' });
    try {
      const project = await createProject(isolated, 'leaky');
      await isolated.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload: { slug: 'card', title: 'card', actor: 'a' },
      });
      const readToken = project.readUrl.split('/r/')[1]!;
      const move = () =>
        isolated.server.inject({
          method: 'POST',
          url: `/r/${readToken}/board/move`,
          payload: 'slug=card&column=doing',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });

      assert.equal((await move()).statusCode, 303);
      assert.equal((await move()).statusCode, 303);
      const third = await move();
      assert.equal(third.statusCode, 429);
      assert.ok(third.headers['retry-after'], 'and it says when to come back');
    } finally {
      await isolated.stop();
    }
  });

  it('moves a card from the board page without JavaScript', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'card', title: 'card', actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /<form class="move" method="post"/);
    assert.match(page.body, /name="column"/);
    // One script, and the move above happened without it: this is the form the
    // drag ends up submitting, exercised the way a browser with scripting off
    // submits it.
    assert.equal([...page.body.matchAll(/<script\b/gi)].length, 1, 'the drag, and nothing else');

    const moved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/move`,
      payload: 'slug=card&column=done',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(moved.statusCode, 303);
    assert.match(moved.headers.location as string, /moved=card&landed=done/);

    const after = await harness.server.inject({
      method: 'GET',
      url: moved.headers.location as string,
    });
    assert.match(after.body, /is now in Done/);
  });
});

describe('a board many agents write to', () => {
  it('names the agent on every card, and never the word "agent"', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'held',
      title: 'held',
      owner: 'alex',
      actor: 'errors-loop',
    });
    await post(project, '/items', { slug: 'touched', title: 'touched', actor: 'scoring-loop' });
    await post(project, '/items/held/claim', { agent: 'errors-loop', ttl_minutes: 30 });

    const view = await board(project);
    const doing = cell(view, 'doing').items[0];
    assert.equal(doing.claim.agent, 'errors-loop');
    assert.equal(doing.last_actor, 'errors-loop');

    const todo = cell(view, 'todo').items[0];
    assert.equal(todo.claim, null);
    assert.equal(todo.last_actor, 'scoring-loop', 'the last writer is on an item nobody holds');

    await post(project, '/agents', {
      handle: 'errors-loop',
      scope: ['errors:'],
      description: 'classifies runtime errors',
    });

    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /errors-loop/i);
    assert.match(page.body, /last: scoring-loop/i);
    assert.match(page.body, /owner:/i, 'owners are labelled as owners, not left bare');
    assert.match(
      page.body,
      /title="classifies runtime errors"/,
      'a handle carries what that agent is for, so nobody looks it up elsewhere',
    );
  });

  it('does not let hygiene claim to be the last one working', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'forgotten', title: 'forgotten', actor: 'errors-loop' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'forgotten' },
      { $set: { touchedAt: new Date(Date.now() - 200 * 3_600_000) } },
    );
    await post(project, '/sweep', {});

    const item = await harness.store.items.findOne({ projectId: project.id, slug: 'forgotten' });
    assert.equal(item!.stale, true, 'the sweep did run');
    assert.equal(item!.lastActor, 'errors-loop', 'and it is still the agent who wrote it');
  });

  it('narrows the board to one owner and to one agent', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'alex-open',
      title: 'alex open',
      owner: 'alex',
      actor: 'errors-loop',
    });
    await post(project, '/items', {
      slug: 'kasia-open',
      title: 'kasia open',
      owner: 'kasia',
      actor: 'trades-loop',
    });
    await post(project, '/items', { slug: 'held', title: 'held', owner: 'kasia', actor: 'a' });
    await post(project, '/items/held/claim', { agent: 'errors-loop', ttl_minutes: 30 });

    const byOwner = await board(project, '?owner=kasia');
    assert.equal(byOwner.filter.owner, 'kasia');
    const owned = byOwner.rows[0].columns.flatMap((column: { items: unknown[] }) => column.items);
    assert.equal(owned.length, 2, 'both of kasia’s, in whichever column they fall');

    const byAgent = await board(project, '?agent=errors-loop');
    assert.equal(byAgent.filter.agent, 'errors-loop');
    const slugs = byAgent.rows[0].columns
      .flatMap((column: { items: Array<{ slug: string }> }) => column.items)
      .map((item: { slug: string }) => item.slug)
      .sort();
    // Holding it counts, and so does having been the last to write to it.
    assert.deepEqual(slugs, ['alex-open', 'held']);

    const whole = await board(project);
    assert.deepEqual(whole.filter, {}, 'an unfiltered board says so rather than staying silent');
  });

  it('drops an agent’s items from their board once the lease lapses', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'lapsing', title: 'lapsing', actor: 'somebody-else' });
    await post(project, '/items/lapsing/claim', { agent: 'errors-loop', ttl_minutes: 30 });
    // Another agent writes after the claim, so lastActor is no longer the holder.
    await post(project, '/items/lapsing/timeline', { actor: 'somebody-else', message: 'looked' });

    const held = await board(project, '?agent=errors-loop');
    assert.equal(held.rows[0].columns.flatMap((c: { items: unknown[] }) => c.items).length, 1);

    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'lapsing' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );

    const lapsed = await board(project, '?agent=errors-loop');
    assert.equal(
      lapsed.rows[0].columns.flatMap((c: { items: unknown[] }) => c.items).length,
      0,
      'an expired claim is not a claim here either',
    );
  });

  it('stays on the same narrowed board after moving a card', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'mine', title: 'mine', owner: 'alex', actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?owner=alex`,
    });
    // Prefixed, because a write form can also carry a field of its own called
    // owner, and the two mean different things.
    assert.match(page.body, /<input type="hidden" name="from_owner" value="alex">/);

    const moved = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/move`,
      payload: 'slug=mine&column=done&from_owner=alex',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(moved.statusCode, 303);
    assert.match(moved.headers.location as string, /owner=alex/);
  });

  it('offers only names that have work behind them', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'one',
      title: 'one',
      owner: 'alex',
      actor: 'errors-loop',
    });
    await post(project, '/agents', { handle: 'idle-loop', scope: [] });

    const facets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(facets.owners, ['alex']);
    assert.ok(facets.agents.includes('errors-loop'));
    assert.ok(facets.agents.includes('idle-loop'), 'a registered agent counts even before it writes');
  });

  // It was counting both of these and returning neither, while reporting in
  // `omitted` how many names it had left off a list it never sent.
  it('hands back the labels and namespaces it was already counting', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'ops:sweep',
      title: 'sweep',
      labels: ['ops'],
      actor: 'a',
    });
    await post(project, '/items', {
      slug: 'build:pager',
      title: 'pager',
      labels: ['build', 'urgent'],
      actor: 'a',
    });
    await post(project, '/items', { slug: 'loose-end', title: 'loose end', actor: 'a' });
    // Two namespaces one is a prefix of the other, which is what makes the
    // delimiter part of the value rather than decoration.
    await post(project, '/items', { slug: 'ops2:migrate', title: 'migrate', actor: 'a' });

    const facets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(facets.labels, ['build', 'ops', 'urgent']);
    assert.deepEqual(facets.prefixes, ['build:', 'ops:', 'ops2:']);
    assert.equal(facets.omitted.prefixes, 0);

    // Passed back as it was handed over, it answers with one area. Without the
    // delimiter it would answer with two, which is the wrong board.
    const narrowed = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/items?prefix=ops:`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(
      narrowed.items.map((item: { slug: string }) => item.slug),
      ['ops:sweep'],
    );

    // Every name it offers has to answer with something, or the list is a set
    // of filters that read as an empty board.
    for (const prefix of facets.prefixes) {
      const page = (
        await harness.server.inject({
          method: 'GET',
          url: `${project.api}/items?prefix=${encodeURIComponent(prefix)}`,
          headers: authed(project),
        })
      ).json();
      assert.ok(page.items.length > 0, `prefix ${prefix} came back empty`);
    }
  });

  it('offers nothing that only closed work carries, when the board hides it', async () => {
    const project = await createProject(harness);
    await put(project, '/board', {
      columns: [{ title: 'Open', match: { status: ['open'] } }],
    });
    await post(project, '/items', {
      slug: 'shipped',
      title: 'shipped last year',
      owner: 'sam',
      labels: ['archive'],
      status: 'done',
      actor: 'old-loop',
    });
    await post(project, '/items', {
      slug: 'live',
      title: 'still open',
      owner: 'alex',
      labels: ['build'],
      actor: 'errors-loop',
    });

    const facets = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    // Offering `sam` or `archive` here is offering a filter whose board comes
    // back empty: this layout has no column that could show what is behind it.
    assert.deepEqual(facets.owners, ['alex']);
    assert.ok(!facets.agents.includes('old-loop'), 'only ever wrote to closed work');
    assert.ok(facets.agents.includes('errors-loop'));

    // And the same board with a column for finished work offers both again.
    await put(project, '/board', {
      columns: [
        { title: 'Open', match: { status: ['open'] } },
        { title: 'Done', match: { status: ['done'] } },
      ],
    });
    const wider = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(wider.owners, ['alex', 'sam']);
    assert.ok(wider.agents.includes('old-loop'));
  });

  it('offers every agent by its own name, described, in the browser too', async () => {
    const project = await createProject(harness, 'many hands');
    await post(project, '/agents', {
      handle: 'errors-loop',
      scope: [],
      description: 'watches the exchange error feed',
    });
    await post(project, '/agents', { handle: 'idle-loop', scope: [], description: '' });
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'errors-loop' });
    // Never registered, only ever wrote. Still a name the board can be narrowed to.
    await post(project, '/items', { slug: 'two', title: 'two', actor: 'passer-by' });

    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });

    // A handle is a line number; what it is for is the name, and in a field
    // with a list behind it that description is the label the browser shows
    // beside the handle.
    assert.match(
      page.body,
      /<option value="errors-loop">watches the exchange error feed<\/option>/,
      'the description travels with the handle',
    );
    assert.match(
      page.body,
      /<option value="idle-loop">registered here<\/option>/,
      'registered and silent still gets offered',
    );
    assert.match(
      page.body,
      /<option value="passer-by">seen on items, not registered here<\/option>/,
      'and a name that only ever wrote is offered as one',
    );

    const described = (
      await harness.server.inject({
        method: 'GET',
        url: `${project.api}/board/facets`,
        headers: authed(project),
      })
    ).json();
    assert.deepEqual(described.agentsDescribed, [
      { handle: 'errors-loop', description: 'watches the exchange error feed', registered: true },
    ]);
    assert.equal(described.omitted.agents, 0);
  });

  it('lists the whole roster on the project page, each name a filtered board', async () => {
    const project = await createProject(harness, 'roster');
    await post(project, '/agents', {
      handle: 'errors-loop',
      scope: ['exchange'],
      description: 'watches the exchange error feed',
    });
    await post(project, '/agents', { handle: 'quiet-loop', scope: [], description: '' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.match(
      page.body,
      new RegExp(`<a href="/r/${readToken}/board\\?agent=errors-loop">.*errors-loop</a>`),
      'the handle links to its own board, now with the face that goes with it',
    );
    assert.match(page.body, /<svg class="face"/, 'and a name on this board has a face');
    assert.match(page.body, /watches the exchange error feed/);
    assert.match(page.body, /quiet-loop/, 'a silent agent is still on the roster');
    assert.match(page.body, /said nothing/);
  });

  it('drops the empty fields a form sends, so the URL is the one to share', async () => {
    // Every field goes up on submit, so narrowing by one leaves the other three
    // in the address as `owner=&label=&q=`. That address is what somebody
    // copies to somebody else.
    const project = await createProject(harness, 'clean urls');
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'errors-loop' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const submitted = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?owner=&agent=errors-loop&label=&q=`,
    });
    assert.equal(submitted.statusCode, 303);
    assert.equal(submitted.headers.location, `/r/${readToken}/board?agent=errors-loop`);

    const nothing = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?owner=&agent=&label=&q=`,
    });
    assert.equal(nothing.headers.location, `/r/${readToken}/board`);

    // An address with nothing empty in it is drawn rather than bounced.
    const clean = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?agent=errors-loop`,
    });
    assert.equal(clean.statusCode, 200);

    // And the bounce is free: it happens before the read is charged and before
    // the view is counted, because it is the same reader pressing Enter once.
    // Counted by what a board view actually writes, which is a row with no
    // project on it: a capability page counts the page, never whose it is.
    const views = async () => {
      await flushEvents();
      return harness.store.events.countDocuments({ kind: 'view', detail: 'board' });
    };
    const before = await views();
    await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?owner=&agent=errors-loop&label=&q=`,
    });
    assert.equal(await views(), before, 'a redirect is not somebody reading the board');

    // And the page it bounces to is, so the check above can tell them apart.
    await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board?agent=errors-loop` });
    assert.equal(await views(), before + 1, 'the page it lands on is a read');
  });

  it('does not count the reload it asked for as somebody arriving', async () => {
    // Measured on production before it was fixed: one board left open all
    // night was a view every sixty one seconds, sixty an hour, every one of
    // them counted as a stranger. The report divides cards moved by hand by
    // that number to decide whether anybody moves cards at all, so the beat
    // made the answer no whatever people did.
    const project = await createProject(harness, 'reloading');
    const readToken = (await harness.store.projects.findOne({ _id: project.id }))!.readToken;
    const views = async () => {
      await flushEvents();
      return harness.store.events.countDocuments({ kind: 'view', detail: 'board' });
    };

    const first = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board?agent=errors-loop` });
    assert.equal(first.statusCode, 200);
    const after = await views();

    // The page says where its own reload goes, and it goes somewhere marked.
    const refresh = /<meta http-equiv="refresh" content="([^"]+)">/.exec(first.body)?.[1] ?? '';
    assert.match(refresh, /^60; url=/, refresh);
    const url = refresh.slice(refresh.indexOf('url=') + 4).replace(/&amp;/g, '&');
    assert.match(url, /refreshed=1/, url);
    assert.match(url, /agent=errors-loop/, 'and it keeps what the reader chose');

    const again = await harness.server.inject({ method: 'GET', url });
    assert.equal(again.statusCode, 200, again.body.slice(0, 120));
    assert.equal(await views(), after, 'the reload the page asked for is not a reader');

    // And the mark is not a way to read the board uncounted by accident: a
    // person following a link without it is still counted.
    await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board?agent=errors-loop` });
    assert.equal(await views(), after + 1, 'somebody arriving still counts');

    // Both of the ways this address can be built wrong, asked of the function
    // that builds it. Through the server neither can be reached: inject
    // normalises the request line, so the absolute form never arrives, and a
    // browser percent-encodes a typed `?` before it is sent. A test that only
    // went through the door passed with both faults in place, which is what it
    // did until this was written.
    assert.equal(
      refreshUrl('r_token', '/r/r_token/board?q=why?now'),
      '/r/r_token/board?q=why%3Fnow&refreshed=1',
      'a search with a question mark in it survives the reload',
    );
    assert.equal(
      refreshUrl('r_token', 'http://elsewhere.example/r/r_token/board?agent=a'),
      '/r/r_token/board?agent=a&refreshed=1',
      'and the reload names this service, whatever the request line said',
    );
  });

  it('sends the token back the way it arrived, whatever it was', async () => {
    // The tidy-up bounce runs before anything has looked the token up, so what
    // it puts in the Location is whatever was in the path. Fastify hands it
    // over decoded: a token written as `..%2f%2felsewhere` came back as
    // `/r/..//elsewhere/board`, which is our own host by the rules of a
    // relative redirect and nobody else's by any of them, but it is still a
    // path this service never meant to name.
    const crafted = await harness.server.inject({
      method: 'GET',
      url: '/r/..%2f%2felsewhere.example/board?owner=',
    });
    assert.equal(crafted.statusCode, 303);
    const location = String(crafted.headers.location);
    assert.ok(!location.includes('//'), `a redirect with an authority in it: ${location}`);
    assert.equal(location, '/r/..%2f%2felsewhere.example/board', 'the path exactly as it arrived');

    // Dots included: `%2e%2e` decoded and re-encoded comes back as `..`, which
    // a client resolves away, and `/r/../board` is a path this service never
    // named. The test harness resolves the encoded dots before routing, so the
    // case is written the way it reaches a real server: encoded dots inside a
    // longer token.
    const dotted = await harness.server.inject({
      method: 'GET',
      url: '/r/%2e%2e%2fsomewhere/board?owner=',
    });
    assert.equal(String(dotted.headers.location), '/r/%2e%2e%2fsomewhere/board');

    // A request line may carry an absolute form, which is routed on its path
    // while the authority stays in the target. Echoing that into a Location is
    // an open redirect, so the redirect is built from the one segment this
    // route matched rather than from anything the caller wrote around it.
    const absolute = await harness.server.inject({
      method: 'GET',
      url: 'http://elsewhere.example/r/sometoken/board?owner=',
    });
    assert.equal(String(absolute.headers.location), '/r/sometoken/board');

    // And what it lands on is the 404 any unknown token gets.
    const landed = await harness.server.inject({ method: 'GET', url: location });
    assert.equal(landed.statusCode, 404);
  });

  it('keeps the agent it is already filtered by in the list', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'errors-loop' });
    const readToken = project.readUrl.split('/r/')[1]!;

    // A name that no longer has anything behind it, arriving from a kept URL.
    // It is in the box, so what it filtered by is visible and can be cleared.
    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?agent=gone-loop`,
    });
    // The fact, not the spelling: the box carries the value, whichever order
    // the attributes are written in and whatever the list is called.
    const agentBox = /<input id="filter-agent"[^>]*>/.exec(page.body)?.[0] ?? '';
    assert.match(agentBox, /value="gone-loop"/, 'so what turned it on can turn it off');
    assert.match(agentBox, /list="[^"]+"/, 'and it still offers the list');
    assert.match(page.body, /<option value="gone-loop">/, 'which still holds it');
  });

  it('shows the filter it is filtering by, whatever the list holds', async () => {
    // A filter bar that does not show what it is filtering by is a page
    // disagreeing with itself. The value is in the box now rather than
    // somewhere in a row of names, so the length of the list cannot hide it.
    const project = await createProject(harness);
    const labels = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'zz-last'];
    for (const label of labels) {
      await post(project, '/items', { slug: `item-${label}`, title: label, labels: [label], actor: 'a' });
    }
    const readToken = project.readUrl.split('/r/')[1]!;

    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?label=zz-last`,
    });
    const labelBox = /<input id="filter-label"[^>]*>/.exec(page.body)?.[0] ?? '';
    assert.match(labelBox, /value="zz-last"/, 'the chosen label is in the box');
    assert.match(page.body, /<option value="aa">/, 'and every name is behind the field');
  });

  it('stops offering an agent whose only trace is a lapsed claim', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'passed-on', title: 'passed on', actor: 'first-loop' });
    await post(project, '/items/passed-on/claim', { agent: 'ghost-loop', ttl_minutes: 30 });
    await post(project, '/items/passed-on/timeline', { actor: 'first-loop', message: 'took over' });

    const facets = async () =>
      (
        await harness.server.inject({
          method: 'GET',
          url: `${project.api}/board/facets`,
          headers: authed(project),
        })
      ).json().agents as string[];

    assert.ok((await facets()).includes('ghost-loop'), 'while the lease is live');

    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'passed-on' },
      { $set: { 'claim.expiresAt': new Date(Date.now() - 60_000) } },
    );
    // Offering a name whose board comes back empty is how a filter teaches
    // people not to trust it.
    assert.ok(!(await facets()).includes('ghost-loop'), 'and not once it has lapsed');
    assert.ok((await facets()).includes('first-loop'));
  });

  it('describes every agent on the page, not the first fifty of the project', async () => {
    const project = await createProject(harness, 'crowded');
    // A paid project registers up to two hundred agents; this is the tier the
    // old fixed limit of fifty was wrong for.
    await harness.store.projects.updateOne(
      { _id: project.id },
      { $set: { tier: 'pro', limits: { items: 20_000, agents: 200, escalations: 5_000 } } },
    );
    // Registered last, so an unsorted head of the collection would miss it.
    for (let index = 0; index < 55; index += 1) {
      const registered = await post(project, '/agents', {
        handle: `loop-${index}`,
        description: `loop number ${index}`,
      });
      assert.equal(registered.statusCode, 201, `loop-${index} registered`);
    }
    await post(project, '/items', { slug: 'late', title: 'late', actor: 'loop-54' });

    const readToken = project.readUrl.split('/r/')[1]!;
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /title="loop number 54"/);
  });
});

describe('the card preview', () => {
  it('carries the whole title, the body and who did what, without JavaScript', async () => {
    const project = await createProject(harness);
    const title =
      'A withdraw stuck in pending for forty minutes, three tickets from the same user and one from support';
    await post(project, '/items', {
      slug: 'errors:withdraw-stuck',
      title,
      body: 'The full description, which a 230px column has no room for.',
      actor: 'errors-loop',
    });
    await post(project, '/items/errors:withdraw-stuck/timeline', {
      actor: 'errors-loop',
      message: 'Venue support says the batch is queued behind a maintenance window.',
    });

    const readToken = project.readUrl.split('/r/')[1]!;
    const closed = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    const item = await harness.store.items.findOne({
      projectId: project.id,
      slug: 'errors:withdraw-stuck',
    });

    // The card links to the sheet by address, and the sheet itself is only
    // drawn for the card that was asked for: a board of a hundred done items
    // used to ship a hundred previews to open one.
    assert.match(
      closed.body,
      new RegExp(
        `<a class="peek" href="/r/${readToken}/board\\?card=errors%3Awithdraw-stuck#${item!._id}"`,
      ),
    );
    assert.ok(!closed.body.includes('class="peeked'), 'and no sheet until one is asked for');

    const page = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=${encodeURIComponent('errors:withdraw-stuck')}`,
    });
    assert.match(page.body, new RegExp(`<div class="peeked open" id="${item!._id}"`));
    assert.match(page.body, /three tickets from the same user and one from support/);
    assert.match(page.body, /a 230px column has no room for/);
    assert.match(page.body, /queued behind a maintenance window/, 'and the recent timeline');
    // The sheet itself carries nothing to execute. The one script the page
    // links is the drag, which is about the columns and not about this.
    assert.ok(
      !/<div class="peeked[\s\S]*?<script/i.test(page.body),
      'still nothing to execute inside the sheet',
    );
  });
});

describe('the board over MCP', () => {
  it('is the same board an agent sees over HTTP', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });

    const response = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'board', arguments: {} },
      },
    });
    const view = response.json().result.structuredContent;
    assert.equal(view.totals.find((total: { key: string }) => total.key === 'todo').count, 1);
  });

  it('moves a card and reports where it landed', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 'one', actor: 'a' });

    const response = await harness.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: authed(project),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'move', arguments: { slug: 'one', column: 'doing', agent: 'worker' } },
      },
    });
    const result = response.json().result.structuredContent;
    assert.equal(result.landed_in, 'doing');
    assert.equal(result.item.claim.agent, 'worker');
    assert.deepEqual(result.applied, { status: 'open', claim: true });
  });
});

describe('a card that is blocked says so', () => {
  it('wherever the layout puts it, including in progress', async () => {
    const project = await createProject(harness, 'stuck');
    const readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', { slug: 'jammed', title: 'jammed', actor: 'a' });
    await post(project, '/items/jammed/claim', { agent: 'a', ttl_minutes: 30 });
    await post(project, '/items', { slug: 'jammed', status: 'blocked', actor: 'a' });

    // Somebody holding an item they cannot move is what blocked means, so the
    // claim column keeps it. The card has to say the rest itself, or the
    // question "what is stuck" has no answer on this board.
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /<span class="chip blocked">blocked<\/span>/);
  });
});

describe('acting on a card without a script', () => {
  let project: Project;
  let readToken: string;

  before(async () => {
    project = await createProject(harness, 'hands on');
    readToken = project.readUrl.split('/r/')[1]!;
    await post(project, '/items', { slug: 'one', title: 'a thing', actor: 'errors-loop' });
  });

  const form = async (path: string, body: Record<string, string>) =>
    harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/${path}`,
      payload: new URLSearchParams(body).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  it('assigns and unassigns somebody, and says so in the timeline', async () => {
    const assigned = await form('owner', { slug: 'one', owner: 'alex' });
    assert.equal(assigned.statusCode, 303);
    let item = (await read(project, '/items/one')).json().item;
    assert.equal(item.owner, 'alex');
    assert.match(item.timeline.at(-1).message, /assigned to alex/);
    assert.equal(item.timeline.at(-1).by, 'operator');

    // Clearing the field is the honest way to say nobody, so it means nobody.
    await form('owner', { slug: 'one', owner: '' });
    item = (await read(project, '/items/one')).json().item;
    assert.equal(item.owner, null);
    assert.match(item.timeline.at(-1).message, /unassigned/);
  });

  it('tags and untags, without overwriting a label set in the meantime', async () => {
    await form('labels', { slug: 'one', add: 'urgent' });
    // Two tags racing: a read, edit and write back would lose one of them.
    await Promise.all([
      form('labels', { slug: 'one', add: 'ops' }),
      form('labels', { slug: 'one', add: 'docs' }),
    ]);
    let item = (await read(project, '/items/one')).json().item;
    assert.deepEqual([...item.labels].sort(), ['docs', 'ops', 'urgent']);

    await form('labels', { slug: 'one', remove: 'ops' });
    item = (await read(project, '/items/one')).json().item;
    assert.deepEqual([...item.labels].sort(), ['docs', 'urgent']);
    assert.match(item.timeline.at(-1).message, /untagged ops/);
  });

  it('comes back to the board somebody was actually looking at', async () => {
    const back = await form('owner', {
      slug: 'one',
      owner: 'alex',
      from_agent: 'errors-loop',
      from_q: 'thing',
    });
    const location = back.headers.location as string;
    assert.match(location, /agent=errors-loop/);
    assert.match(location, /q=thing/, 'a search survives acting on one of its results');
  });

  it('does not mistake the person being assigned for the board being viewed', async () => {
    // The assign form carries an owner because somebody is changing it. Reading
    // that as the narrowing would drop the operator onto a different board
    // every single time they assigned anybody.
    const landed = await form('owner', { slug: 'one', owner: 'kasia' });
    assert.equal(landed.statusCode, 303);
    assert.doesNotMatch(landed.headers.location as string, /owner=kasia/);

    // And on a board already narrowed to somebody, the two fields coexist.
    const filtered = await form('owner', { slug: 'one', owner: 'alex', from_owner: 'kasia' });
    assert.equal(filtered.statusCode, 303);
    assert.match(filtered.headers.location as string, /owner=kasia/, 'still on kasia\'s board');
    const item = (await read(project, '/items/one')).json().item;
    assert.equal(item.owner, 'alex', 'and alex now owns the card');
  });

  it('refuses the twenty first label instead of growing past the shape', async () => {
    await post(project, '/items', { slug: 'tagged', title: 'tagged', actor: 'a' });
    for (let n = 0; n < 20; n += 1) {
      const added = await form('labels', { slug: 'tagged', add: `label-${n}` });
      assert.equal(added.statusCode, 303, `label ${n} should fit`);
    }
    const full = await form('labels', { slug: 'tagged', add: 'one-too-many' });
    assert.equal(full.statusCode, 409);
    assert.equal(full.json().error, 'too_many_labels');
    const item = (await read(project, '/items/tagged')).json().item;
    assert.equal(item.labels.length, 20);
    assert.ok(!item.labels.includes('one-too-many'));

    // Room again once one goes.
    await form('labels', { slug: 'tagged', remove: 'label-0' });
    const fits = await form('labels', { slug: 'tagged', add: 'one-too-many' });
    assert.equal(fits.statusCode, 303);
  });

  it('refuses to invent an item that is not there', async () => {
    const missing = await form('owner', { slug: 'never-existed', owner: 'alex' });
    assert.equal(missing.statusCode, 404);
    const items = (await read(project, '/items?limit=50')).json().items;
    assert.ok(!items.some((i: { slug: string }) => i.slug === 'never-existed'));
  });
});

describe('a layout that would trap finished work', () => {
  it('is saved and then explained, rather than refused', async () => {
    const project = await createProject(harness, 'trapped');
    const readToken = project.readUrl.split('/r/')[1]!;
    // A label column standing before the column that catches closed work: the
    // board is a partition, so a finished item keeps its label and stays here.
    const saved = await put(project, '/board', {
      rows: 'none',
      columns: [
        { key: 'waiting', title: 'Waiting on the operator', match: { labels: ['waiting'] } },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().warnings.length, 1, 'a filter is never refused, only explained');
    assert.match(saved.json().warnings[0], /Waiting on the operator/);
    assert.match(saved.json().warnings[0], /status/);

    // And the page says it whenever somebody looks, not only after saving.
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /Finished work keeps the label/);
  });

  it('does not offer a move into a column no move could satisfy, and says why', async () => {
    // The move control used to offer every column with something to apply,
    // including ones resting on a filter a move cannot set. Clicking it put
    // the card somewhere else and explained afterwards, which is a control
    // that lies at the moment somebody uses it.
    const project = await createProject(harness, 'views and destinations');
    const readToken = project.readUrl.split('/r/')[1]!;
    const saved = await put(project, '/board', {
      rows: 'none',
      columns: [
        { key: 'urgent', title: 'Urgent', match: { status: ['open'], priorityMin: 5 } },
        { key: 'rotting', title: 'Rotting', match: { stale: true } },
        { key: 'todo', title: 'To do', match: { status: ['open'] } },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    });
    // Not a warning above the board: a column that is honestly a view is not a
    // fault, and nagging about it would nag about the presets this project
    // ships. The layout section answers it where the question is asked.
    assert.deepEqual(saved.json().warnings, []);

    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(page.body, /Views, not destinations/);
    assert.match(page.body, /priority_min/);
    // The card sits in "To do", so the only destination left is the one column
    // a move can satisfy. The two views are offered nowhere.
    assert.ok(page.body.includes('value="done"'), 'a column a move can satisfy is offered');
    assert.ok(!page.body.includes('value="urgent"'), 'and one it cannot is not');
    assert.ok(!page.body.includes('value="rotting"'));
  });

  it('reaches a column whose only filter is freshness, because the move is the write', async () => {
    // A column asking only for `stale: false` derived nothing to apply, so the
    // board decided it was not a destination and a direct move answered
    // column_has_no_move. The operation was always there: any agent write
    // clears the flag, and a move is a write. It just had no name.
    const project = await createProject(harness, 'fresh only');
    const readToken = project.readUrl.split('/r/')[1]!;
    await put(project, '/board', {
      rows: 'none',
      columns: [
        { key: 'fresh', title: 'Fresh', match: { stale: false } },
        { key: 'rotting', title: 'Rotting', match: { stale: true } },
      ],
    });
    await post(project, '/items', { slug: 'old', title: 'old', actor: 'a' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'old' },
      { $set: { stale: true, staleSince: new Date(Date.now() - 86_400_000) } },
    );

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.ok(page.body.includes('value="fresh"'), 'and the control offers it');

    const moved = await post(project, '/items/old/move', { column: 'fresh', actor: 'op' });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().applied.touch, true, 'the move says what it did');
    assert.equal(moved.json().item.stale, false);
    assert.equal(moved.json().landed_in, 'fresh');
  });

  it('documents every key a move can apply, on the page that tells you to write one', async () => {
    // The layout section explains what a filter can say and, when a column is a
    // view, tells its author to declare an "apply" instead. It documented no
    // part of that key, so the advice ended at a word the page never defined.
    // The list comes from the serializer rather than from a copy here: a new
    // key has to round-trip to survive a save, so this fails until it is both
    // saved and explained.
    const project = await createProject(harness, 'apply reference');
    const readToken = project.readUrl.split('/r/')[1]!;
    const keys = Object.keys(
      boardApplyJson({
        status: 'open',
        addLabels: ['a'],
        removeLabels: ['b'],
        owner: 'someone',
        priority: 1,
        claim: true,
        release: false,
        touch: true,
      }),
    );
    assert.ok(keys.length >= 8, 'the serializer still names every key');

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    // Only the part about moves. Half these words are also filter keys, and a
    // check that reads the whole page would pass on the wrong table.
    const section = page.body.split('What a move does')[1] ?? '';
    assert.ok(section.length > 0, 'the section exists');
    for (const key of keys) {
      assert.ok(section.includes(`>${key}<`), `the move reference explains "${key}"`);
    }
  });

  it('refuses a column that says it will not touch, because every move does', async () => {
    // touch: false would have parsed, and an apply with one key in it counts as
    // a move, so a view could have called itself a destination and then
    // reported touch: false on a card the same request had just touched.
    const project = await createProject(harness, 'no touch');
    const rejected = await put(project, '/board', {
      rows: 'none',
      columns: [{ key: 'fresh', title: 'Fresh', match: { stale: false }, apply: { touch: false } }],
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.json().message, /touch can only be true/);
  });

  it('keeps a column for fresh work as a destination, since a move makes it fresh', async () => {
    // The first version of the rule read "stale" as unreachable either way and
    // took the built-in signals preset's own column off the board. A move goes
    // through the ordinary upsert, and every agent write clears the flag, so
    // moving a rotting card into "Fresh" is exactly what makes it fresh.
    const project = await createProject(harness, 'signals');
    const readToken = project.readUrl.split('/r/')[1]!;
    // The API takes a layout, not a preset name; the preset is what the browser
    // form posts. Same columns either way.
    await put(project, '/board', BOARD_PRESETS.signals!.config);

    await post(project, '/items', { slug: 'mirrored', title: 'mirrored', source: 'scanner', actor: 'a' });
    await harness.store.items.updateOne(
      { projectId: project.id, slug: 'mirrored' },
      { $set: { stale: true, staleSince: new Date(Date.now() - 86_400_000) } },
    );
    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.ok(page.body.includes('value="fresh"'), 'the preset offers its own column');
    // The preset's own "Going stale" column is honestly a view, and the layout
    // section says so, but nothing above the board treats it as a fault.
    assert.ok(!page.body.includes('notice warn'), 'a shipped preset does not warn on arrival');

    const moved = await post(project, '/items/mirrored/move', { column: 'fresh', actor: 'op' });
    assert.equal(moved.json().item.stale, false);
    assert.equal(moved.json().landed_in, 'fresh');
  });

  it('moves a card to the person a one-owner column names', async () => {
    // Symmetric with the single status rule: a column for one person's work is
    // a column a move can honour, and it used to change the status and quietly
    // leave the owner alone.
    const project = await createProject(harness, 'mine');
    await put(project, '/board', {
      rows: 'none',
      columns: [
        { key: 'alex', title: 'Alex', match: { status: ['open'], owner: ['alex'] } },
        { key: 'todo', title: 'To do', match: { status: ['open'] } },
      ],
    });
    await post(project, '/items', { slug: 'work', title: 'work', actor: 'a' });
    const moved = await post(project, '/items/work/move', { column: 'alex', actor: 'op' });
    assert.equal(moved.json().item.owner, 'alex');
    assert.equal(moved.json().landed_in, 'alex');
  });

  it('warns even when the column names a status, if that status is a finished one', async () => {
    const project = await createProject(harness, 'half careful');
    const saved = await put(project, '/board', {
      rows: 'none',
      columns: [
        { key: 'waiting', title: 'Waiting', match: { labels: ['waiting'], status: ['open', 'done'] } },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    });
    // Naming statuses is not the same as excluding the finished ones, and the
    // trap is identical: closed work keeps its label and stays in this column.
    assert.equal(saved.json().warnings.length, 1);
  });

  it('says nothing when the same column names its statuses', async () => {
    const project = await createProject(harness, 'careful');
    const saved = await put(project, '/board', {
      rows: 'none',
      columns: [
        {
          key: 'waiting',
          title: 'Waiting',
          match: { labels: ['waiting'], status: ['open', 'blocked'] },
        },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    });
    assert.deepEqual(saved.json().warnings, []);
  });

  it('says how much of the list it is not showing', async () => {
    // The board says "and N more" when a column is cut. The project page said
    // nothing: past two hundred items it stopped, and a page that quietly drops
    // work is worse than one that admits it cannot show everything.
    // Written through the service rather than over HTTP: two hundred and five
    // requests in a loop is eighty five more than the write limit a minute
    // allows, and this test is about the page, not the limiter.
    const { upsertItem } = await import('../src/service.js');
    const project = await createProject(harness, 'a long board');
    const readToken = project.readUrl.split('/r/')[1]!;
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;
    for (let index = 0; index < 205; index += 1) {
      await upsertItem(harness.store, doc, {
        slug: `bulk:${index}`,
        title: `item ${index}`,
        status: 'done',
        actor: 'a',
      });
    }

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Showing 25 of 205/);
    assert.match(page.body, new RegExp(`/r/${readToken}/board`));
    // And the line above the table says the same number, rather than reporting
    // the size of the page as the size of the board.
    assert.match(page.body, /205 items/);
    // And one of a thing is one of it, not "1 item(s)": this line is the first
    // screen a stranger holding the link reads.
    assert.ok(!/\(s\)/.test(page.body), 'nothing on this page counts in parentheses');
  });

  it('puts the live work above the finished pile, and stops at what a phone can carry', async () => {
    // Sorting on the status word put "blocked" first and "open" last, because
    // that is alphabetical, so the work somebody could actually pick up sat
    // underneath every finished card. Harmless while the table showed two
    // hundred rows; with a limit on it, the open items were what fell off.
    const { upsertItem } = await import('../src/service.js');
    const project = await createProject(harness, 'a working board');
    const readToken = project.readUrl.split('/r/')[1]!;
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;
    for (let index = 0; index < 30; index += 1) {
      await upsertItem(harness.store, doc, {
        slug: `closed:${index}`,
        title: `finished ${index}`,
        status: 'done',
        actor: 'a',
      });
    }
    await upsertItem(harness.store, doc, { slug: 'live:one', title: 'still going', actor: 'a' });

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.equal(page.statusCode, 200);
    const rows = page.body.split('<tr>');
    const live = rows.findIndex((row) => row.includes('live:one'));
    const finished = rows.findIndex((row) => row.includes('closed:'));
    assert.ok(live > 0, 'the open item is on the page at all');
    assert.ok(live < finished, 'and above the finished ones');
    assert.match(page.body, /Showing 25 of 31/);
  });

  it('finds an open question behind a wall of answered ones', async () => {
    // One query for the newest fifty of both kinds loses an open question as
    // soon as fifty newer ones have been answered. The audit found exactly this
    // in the MCP inbox and fixed it there; the page a person actually opens
    // kept it, which is the door that matters most for a question.
    const { createEscalation, answerEscalation } = await import('../src/service.js');
    const project = await createProject(harness, 'a busy queue');
    const readToken = project.readUrl.split('/r/')[1]!;
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;

    const old = await createEscalation(
      harness.store,
      doc,
      { agent: 'a', question: 'the one nobody can see?' },
      'http',
    );
    for (let index = 0; index < 60; index += 1) {
      const later = await createEscalation(
        harness.store,
        doc,
        { agent: 'a', question: `noise ${index}` },
        'http',
      );
      await answerEscalation(harness.store, doc._id, later._id, 'resolved', 'done', 'http');
    }

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /the one nobody can see\?/);
    assert.match(page.body, new RegExp(`/r/${readToken}/escalations/${old._id}`));

    // And answering it says so. The same trap one step along: the confirmation
    // is drawn from the answered list, and ordered by age this question falls
    // off the end of that too, on exactly the question that was hardest to see.
    const answered = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/escalations/${old._id}`,
      payload: 'status=answered&answer=at+last',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(answered.statusCode, 303);
    const back = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}?answered=${old._id}`,
    });
    assert.match(back.body, /Answered\./, 'the confirmation names it');
    assert.match(back.body, /at last/, 'and the answer is in the history');

    // And it still says so after the history has moved on without it. Fifty
    // decisions later this question is nowhere near the recent list, and the
    // confirmation is exactly what somebody needs on the question that was
    // hardest to find.
    for (let index = 0; index < 51; index += 1) {
      const later = await createEscalation(
        harness.store,
        doc,
        { agent: 'a', question: `after ${index}` },
        'http',
      );
      await answerEscalation(harness.store, doc._id, later._id, 'resolved', 'later', 'http');
    }
    const much = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}?answered=${old._id}`,
    });
    assert.match(much.body, /Answered\./, 'the confirmation is not drawn from a slice');
  });

  it('does not let a retry of an old answer look like a new one', async () => {
    // The history a person reads is ordered by when a question was answered,
    // so a client retrying last week's answer after a timeout would climb over
    // this morning's decisions if the retry moved that date.
    const { createEscalation, answerEscalation } = await import('../src/service.js');
    const project = await createProject(harness, 'retries');
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;
    const question = await createEscalation(
      harness.store,
      doc,
      { agent: 'a', question: 'decided once?' },
      'http',
    );

    await answerEscalation(harness.store, doc._id, question._id, 'answered', 'yes', 'http');
    const first = (await harness.store.escalations.findOne({ _id: question._id }))!.answeredAt;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await answerEscalation(harness.store, doc._id, question._id, 'answered', 'yes', 'http');
    const after = (await harness.store.escalations.findOne({ _id: question._id }))!.answeredAt;
    assert.equal(after!.getTime(), first!.getTime(), 'the same answer twice is one decision');

    // A different answer is a decision, and moves it.
    await answerEscalation(harness.store, doc._id, question._id, 'answered', 'no', 'http');
    const changed = (await harness.store.escalations.findOne({ _id: question._id }))!.answeredAt;
    assert.ok(changed!.getTime() > first!.getTime());
  });

  it('says when it is showing some of the questions rather than all', async () => {
    const { createEscalation } = await import('../src/service.js');
    const project = await createProject(harness, 'a long queue');
    const readToken = project.readUrl.split('/r/')[1]!;
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;
    for (let index = 0; index < 55; index += 1) {
      await createEscalation(harness.store, doc, { agent: 'a', question: `q${index}` }, 'http');
    }

    const page = await harness.server.inject({ method: 'GET', url: `/r/${readToken}` });
    assert.match(page.body, /55 questions/, 'the summary counts them all');
    assert.match(page.body, /Showing the 50 most urgent of 55/, 'and the list says it is a slice');
  });
});

describe('a card whose blockers are finished', () => {
  /**
   * `blocked_by` is a declaration and stays true after the cards it names are
   * done, which is right: it records what this work came after. What is not
   * right is reading it as a state. The card face already asked the live map
   * and the sheet on the same page printed the declaration, so one page said
   * "Waiting on ops:bridge" about a card that was free to take, beside a chip
   * that knew better.
   */
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('stops saying it is waiting, on the sheet as well as the face', async () => {
    const project = await createProject(harness, 'finished blockers');
    const file = async (payload: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload,
      });
    await file({ slug: 'ops:first', title: 'the thing that has to happen first' });
    await file({ slug: 'ops:after', title: 'the card that waits', blocked_by: ['ops:first'] });
    const readToken = project.readUrl.split('/r/')[1]!;

    const waiting = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=ops:after`,
    });
    assert.match(waiting.body, /Waiting on <code>ops:first<\/code>/, 'while it really is waiting');

    await file({ slug: 'ops:first', status: 'done', note: 'finished' });

    const free = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=ops:after`,
    });
    assert.ok(!free.body.includes('Waiting on <code>ops:first'), 'and not once it is not');
    assert.match(free.body, /every one of them is finished, so this card is free to take/);

    // The service agrees: it is offered and it can be claimed.
    const offered = await harness.server.inject({
      method: 'POST',
      url: `${project.api}/next`,
      headers: authed(project),
      payload: { agent: 'somebody' },
    });
    assert.equal(offered.json().item?.slug, 'ops:after', 'the same card the sheet now calls free');
  });

  it('does not call a card free to take because it is finished', async () => {
    // The live map is asked about work that is not finished, so a done or
    // dropped card is missing from it whatever its blockers are doing, and a
    // card somebody parked as blocked is missing once they are done while
    // still not being offered. Reading an empty answer as "nothing is holding
    // this up" was wrong in both directions.
    const project = await createProject(harness, 'terminal blockers');
    const file = async (payload: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: authed(project),
        payload,
      });
    await file({ slug: 'ops:still-open', title: 'nobody has finished this' });
    await file({ slug: 'ops:finished', title: 'a card somebody closed', blocked_by: ['ops:still-open'] });
    await file({ slug: 'ops:finished', status: 'done', note: 'closed while its blocker was open' });
    await file({ slug: 'ops:parked', title: 'a card waiting on a person', blocked_by: ['ops:still-open'] });
    await file({ slug: 'ops:parked', status: 'blocked', note: 'waiting on the operator' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const closed = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=ops:finished`,
    });
    assert.match(closed.body, /Filed after <code>ops:still-open<\/code>\./);
    assert.ok(
      !closed.body.includes('free to take'),
      'a finished card is not free to take, and its blocker is not finished either',
    );

    // A parked card really is waiting, and says so.
    const parked = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=ops:parked`,
    });
    assert.match(parked.body, /Waiting on <code>ops:still-open<\/code>/);
    assert.ok(!parked.body.includes('free to take'));
  });
});

describe('a card link that names nothing', () => {
  /**
   * The operator's page links straight to a card with `?card=<slug>`, and a
   * link like that outlives what it points at. Naming a card this project
   * never had drew the plain board and said nothing, so somebody who followed
   * a stale link was shown a page that looked like it had worked.
   *
   * The lookup falls back to the whole project rather than to what the board
   * happens to be drawing, so a card that is merely off the board still opens.
   * Nothing left means nothing by that name exists here.
   */
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.stop();
  });

  it('says so, and still draws the board', async () => {
    const project = await createProject(harness, 'a stale link');
    await harness.server.inject({
      method: 'POST',
      url: `${project.api}/items`,
      headers: authed(project),
      payload: { slug: 'ops:real', title: 'a card that is really here' },
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const missing = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=ops:never-existed`,
    });
    assert.equal(missing.statusCode, 200, 'the board is still worth drawing');
    // Quoted in the sentence, so quoted as an entity by the time it is HTML.
    assert.match(missing.body, /has no card called &quot;ops:never-existed&quot;/);
    assert.match(missing.body, /a card that is really here/, 'and the board is under it');

    // The name is echoed back, so it is escaped like anything else somebody
    // put in a URL.
    const injected = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=${encodeURIComponent('<script>alert(1)</script>')}`,
    });
    assert.equal(injected.statusCode, 200);
    assert.ok(!injected.body.includes('<script>alert(1)</script>'), 'not as markup');
    assert.match(injected.body, /&lt;script&gt;/, 'as the text it is');

    // A card that exists says nothing of the sort, whether or not the board is
    // currently drawing it.
    const found = await harness.server.inject({
      method: 'GET',
      url: `/r/${readToken}/board?card=ops:real`,
    });
    assert.ok(!found.body.includes('has no card called'), 'a card that is here opens quietly');
    assert.match(found.body, /a card that is really here/);

    // And a board asked for without a card is unchanged.
    const plain = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.ok(!plain.body.includes('has no card called'));
  });
});

describe('a board with nothing on it', () => {
  it('names this project, because the protocol starts by making a new one', async () => {
    // Advice that produces a second board is worse than no advice: skill.md
    // opens with "get a project", so an agent sent there without this board's
    // name signs up again and writes somewhere nobody is looking.
    const project = await createProject(harness);
    const readToken = project.readUrl.split('/r/')[1]!;
    const board = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(board.body, /Nothing on this board yet/);
    assert.match(board.body, new RegExp(project.id));
    assert.match(board.body, /token is not on this page/);
  });

  it('says nothing of the sort when the layout is what is empty', async () => {
    // A board whose columns match none of its items has work on it and says so
    // in its own warning. Telling that reader nobody has written here is the
    // one sentence that would send them looking for an agent that is running.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'real-work', title: 't', body: 'b', actor: 'a' });
    await put(project, '/board', {
      columns: [{ key: 'never', title: 'Never matches', match: { labels: ['nothing-has-this'] } }],
    });
    const board = await harness.server.inject({ method: 'GET', url: `/r/${readToken(project)}/board` });
    assert.doesNotMatch(board.body, /Nothing on this board yet/);
    assert.match(board.body, /match no column/);
  });
});

function readToken(project: Project): string {
  return project.readUrl.split('/r/')[1]!;
}

describe('a card that waits on another', () => {
  it('is not offered, refuses a claim, and names what is unfinished', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'first', title: 'the prerequisite', body: 'b', actor: 'a' });
    await post(project, '/items', {
      slug: 'second',
      title: 'the one that waits',
      body: 'b',
      blocked_by: ['first'],
      actor: 'a',
    });

    // The offer skips it and says how many it held back, because a board that
    // looks emptier than it is should explain itself.
    const offered = await read(project, '/next?agent=a');
    assert.equal(offered.json().item.slug, 'first');

    const claim = await post(project, '/items/second/claim', { agent: 'a' });
    assert.equal(claim.statusCode, 409);
    assert.equal(claim.json().error, 'blocked_by');
    assert.match(claim.json().message, /first/);
    assert.match(claim.json().message, /open/, 'the status of what it waits on');

    // Finishing the blocker is all it takes: no sweep, no second write, nothing
    // to keep in step.
    await post(project, '/items', { slug: 'first', status: 'done', actor: 'a' });
    const now = await post(project, '/items/second/claim', { agent: 'a' });
    assert.equal(now.statusCode, 200);
    assert.equal(now.json().ok, true);
  });

  it('waits on a card nobody filed, and says that rather than pretending', async () => {
    const project = await createProject(harness);
    await post(project, '/items', {
      slug: 'typo',
      title: 'waits on a name that does not exist',
      body: 'b',
      blocked_by: ['ops:nothing-like-this'],
      actor: 'a',
    });
    const claim = await post(project, '/items/typo/claim', { agent: 'a' });
    assert.equal(claim.statusCode, 409);
    assert.match(claim.json().message, /not on this board/);

    // And clearing the list is one write, not a support ticket.
    await post(project, '/items', { slug: 'typo', blocked_by: [], actor: 'a' });
    const after = await post(project, '/items/typo/claim', { agent: 'a' });
    assert.equal(after.statusCode, 200);
  });

  it('refuses a blocker that is not a slug, rather than dropping it', async () => {
    // Dropping it stored a card that waits on nothing and then claims
    // cleanly, which is the one outcome the field exists to prevent, reached
    // by a typo nobody was told about.
    const project = await createProject(harness);
    const written = await post(project, '/items', {
      slug: 'typo-blocker',
      title: 't',
      blocked_by: ['!!!'],
      actor: 'a',
    });
    assert.equal(written.statusCode, 400);
    assert.equal(written.json().error, 'bad_blocked_by');
  });

  it('does not lease a card whose blocker was reopened while it was being taken', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'gate', title: 'gate', body: 'b', status: 'done', actor: 'a' });
    await post(project, '/items', { slug: 'behind', title: 'behind', body: 'b', blocked_by: ['gate'], actor: 'a' });

    // Finished, so it claims.
    const first = await post(project, '/items/behind/claim', { agent: 'a' });
    assert.equal(first.statusCode, 200);
    await post(project, '/items/behind/release', { agent: 'a' });

    await post(project, '/items', { slug: 'gate', status: 'open', actor: 'a' });
    const second = await post(project, '/items/behind/claim', { agent: 'b' });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, 'blocked_by');

    // And no lease was left behind by the refusal.
    const item = await read(project, '/items/behind');
    assert.equal(item.json().item.claim, null);
  });

  it('answers a person on the page when the field will not take what they typed', async () => {
    // The refusals this field can produce are about what somebody typed into
    // it, and a person who typed it is looking at the board rather than at a
    // JSON body. Nothing is written and the board says so.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'from-the-page', title: 't', body: 'b', actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;
    const refused = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/waiting`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ slug: 'from-the-page', waiting: '!!! ???' }).toString(),
    });
    assert.equal(refused.statusCode, 303);
    assert.match(refused.headers.location as string, /what=waiting_refused/);
    const page = await harness.server.inject({
      method: 'GET',
      url: refused.headers.location as string,
    });
    assert.match(page.body, /Nothing was written/);
    const item = await read(project, '/items/from-the-page');
    assert.equal((item.json().item.blocked_by ?? []).length, 0);
  });

  it('stops calling a card blocked once its prerequisites are finished', async () => {
    // The list stays on the card after the work it depended on closes, which
    // is right: it is a record of what this waited for. What the board must
    // not do is keep saying "waiting" about work anybody may now take.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'gate-a', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items', { slug: 'after-a', title: 't', body: 'b', blocked_by: ['gate-a'], actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;

    const blocked = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(blocked.body, /waiting on gate-a/);

    await post(project, '/items', { slug: 'gate-a', status: 'done', actor: 'a' });
    const free = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.doesNotMatch(free.body, /waiting on gate-a/, 'the chip goes when the blocking does');
    // And the record of what it waited for is still on the card.
    const item = await read(project, '/items/after-a');
    assert.deepEqual(item.json().item.blocked_by, ['gate-a']);
  });

  it('counts what is still unfinished, and keeps saying so on a card somebody parked', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'gate-1', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items', { slug: 'gate-2', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items', {
      slug: 'after-both',
      title: 't',
      body: 'b',
      blocked_by: ['gate-1', 'gate-2'],
      actor: 'a',
    });
    const readToken = project.readUrl.split('/r/')[1]!;

    const two = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(two.body, /waiting on 2/);

    // One finishes: the chip counts what is left, not what it once waited for.
    await post(project, '/items', { slug: 'gate-1', status: 'done', actor: 'a' });
    const one = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(one.body, /waiting on gate-2/);
    assert.doesNotMatch(one.body, /waiting on 2/);

    // And a card a person parked as blocked still refuses a claim over its
    // dependency, so the board has to keep saying so.
    await post(project, '/items', { slug: 'after-both', status: 'blocked', actor: 'a' });
    const parked = await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` });
    assert.match(parked.body, /waiting on gate-2/);
  });

  it('counts only the work it could have offered as withheld', async () => {
    // A card somebody parked as blocked was never a candidate, so counting it
    // as held back tells an agent there is more work behind the curtain than
    // there is.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'gate', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items', { slug: 'parked', title: 't', body: 'b', status: 'blocked', blocked_by: ['gate'], actor: 'a' });
    await post(project, '/items', { slug: 'open-and-waiting', title: 't', body: 'b', blocked_by: ['gate'], actor: 'a' });
    // The blocker itself is the only free card, so it goes to somebody and the
    // board is left with nothing anybody can take.
    await post(project, '/items/gate/claim', { agent: 'somebody-else' });

    const offered = await read(project, '/next?agent=nobody-in-particular');
    assert.equal(offered.json().item, null);
    assert.match(
      offered.json().reason,
      /1 item is waiting on other cards/,
      'the parked card was never on offer, so it is not counted as held back',
    );
  });

  it('says which of the three refusals it was, not one sentence for all of them', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'itself', title: 't', body: 'b', actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;
    const refused = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/waiting`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ slug: 'itself', waiting: 'itself' }).toString(),
    });
    assert.match(refused.headers.location as string, /what=waiting_itself/);
    const page = await harness.server.inject({
      method: 'GET',
      url: refused.headers.location as string,
    });
    assert.match(page.body, /cannot wait on itself/);
  });

  it('takes a list a person typed with commas, spaces or both', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'one', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items', { slug: 'two', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items', { slug: 'waits-for-both', title: 't', body: 'b', actor: 'a' });
    const readToken = project.readUrl.split('/r/')[1]!;
    const set = await harness.server.inject({
      method: 'POST',
      url: `/r/${readToken}/board/waiting`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ slug: 'waits-for-both', waiting: 'one,  two' }).toString(),
    });
    assert.equal(set.statusCode, 303);
    const item = await read(project, '/items/waits-for-both');
    assert.deepEqual(item.json().item.blocked_by, ['one', 'two']);

    // And an agent is refused it, which is the point of the field.
    const claim = await post(project, '/items/waits-for-both/claim', { agent: 'a' });
    assert.equal(claim.statusCode, 409);
  });

  it('refuses to wait on itself', async () => {
    const project = await createProject(harness);
    const written = await post(project, '/items', {
      slug: 'ouroboros',
      title: 't',
      blocked_by: ['ouroboros'],
      actor: 'a',
    });
    assert.equal(written.statusCode, 400);
    assert.equal(written.json().error, 'bad_blocked_by');
  });

  it('takes the next item that is not waiting, when one call does both', async () => {
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'blocked-one', title: 'waits', body: 'b', priority: 9, blocked_by: ['nobody-filed-this'], actor: 'a' });
    await post(project, '/items', { slug: 'free-one', title: 'ready', body: 'b', priority: 1, actor: 'a' });

    // Priority would have handed over the blocked card first. Offering work a
    // claim would refuse is a loop an agent cannot get out of.
    const taken = await post(project, '/next', { agent: 'worker' });
    assert.equal(taken.statusCode, 200);
    assert.equal(taken.json().item.slug, 'free-one');
    assert.equal(taken.json().claimed, true);
  });
});

describe('handing a lease straight back', () => {
  it('clears the lease it took, records it, and leaves a renewed one alone', async () => {
    // The rollback the blocker guard uses when it loses a race. Guarded on the
    // exact lease rather than on the holder's name, because the same agent can
    // heartbeat between the two writes and a rollback matching only the name
    // deletes a newer, valid lease while that request reports success.
    const project = await createProject(harness);
    await post(project, '/items', { slug: 'leased', title: 't', body: 'b', actor: 'a' });
    await post(project, '/items/leased/claim', { agent: 'a', ttl_minutes: 30 });

    // The lease names itself, and only the writer that put that name there may
    // take it away: an expiry cannot do the job, because two requests renewing
    // in the same millisecond compute the same one.
    const doc = (await harness.store.projects.findOne({ _id: project.id }))!;
    const held = (await harness.store.items.findOne({ projectId: doc._id, slug: 'leased' }))!;
    const mine = held.claim!.nonce!;
    assert.ok(mine, 'a lease carries which lease it is');

    await handBack(harness.store, doc._id, 'leased', 'a', 'l_somebodyelse', 'a lease this call never took');
    const untouched = await read(project, '/items/leased');
    assert.ok(untouched.json().item.claim, 'a lease this rollback did not take is not its to clear');

    await handBack(harness.store, doc._id, 'leased', 'a', mine, 'waiting on something');
    const cleared = await read(project, '/items/leased');
    assert.equal(cleared.json().item.claim, null);
    const entries = (cleared.json().item.timeline ?? []) as Array<{ message: string }>;
    assert.ok(
      entries.some((entry) => /handed straight back: waiting on something/.test(entry.message)),
      'the history is continued, not unwound: the claim really happened',
    );
  });
});
