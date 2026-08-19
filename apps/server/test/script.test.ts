import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { SCRIPT_BODY } from '../src/html.js';
import { createProject, startHarness, type Harness } from './helper.js';

/**
 * The one script this service serves, run.
 *
 * Everything else here is checked by asking the server what it wrote. This is
 * the only code in the repo the suite could not execute, and in a single day
 * it shipped two defects because of that: a lookup left pointing at an
 * attribute that had moved to another element, and a guard that returned from
 * the whole script and took the fields with it. Codex found one and a browser
 * found the other; nothing here could have.
 *
 * The page is the real one, rendered by the server, so the markup and the
 * script are never two ideas of the same thing.
 */
describe('the script the board carries', () => {
  let harness: Harness;
  let board: string;
  let sheet: string;
  let swimlanes: string;

  before(async () => {
    harness = await startHarness();

    const flat = await createProject(harness, 'script, one lane');
    const post = (project: { api: string; token: string }, payload: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: `${project.api}/items`,
        headers: { authorization: `Bearer ${project.token}`, 'content-type': 'application/json' },
        payload,
      });
    await post(flat, { slug: 'one', title: 'a card', owner: 'alex', labels: ['ops'] });
    await post(flat, { slug: 'two', title: 'another' });
    const readToken = flat.readUrl.split('/r/')[1];
    board = (await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board` })).body;
    // The fields on a card live in its sheet, which an address opens.
    sheet = (
      await harness.server.inject({ method: 'GET', url: `/r/${readToken}/board?card=one` })
    ).body;

    const laned = await createProject(harness, 'script, two lanes');
    await post(laned, { slug: 'alex-work', title: 'alex', owner: 'alex' });
    await post(laned, { slug: 'bob-work', title: 'bob', owner: 'bob' });
    await harness.server.inject({
      method: 'PUT',
      url: `${laned.api}/board`,
      headers: { authorization: `Bearer ${laned.token}`, 'content-type': 'application/json' },
      payload: {
        rows: 'owner',
        columns: [
          { key: 'open', title: 'Open', match: { status: ['open'] } },
          { key: 'alexs', title: 'Alex', match: { status: ['open'], owner: ['alex'] } },
          { key: 'bobs', title: 'Bob', match: { status: ['open'], owner: ['bob'] } },
        ],
      },
    });
    swimlanes = (
      await harness.server.inject({
        method: 'GET',
        url: `/r/${laned.readUrl.split('/r/')[1]}/board`,
      })
    ).body;
  });

  after(async () => {
    await harness.stop();
  });

  /** The page, with the script run against it, and a pointer of our choosing. */
  type Page = ReturnType<typeof pageOf>;
  const pageOf = (html: string, { fine = true } = {}) => {
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as unknown as Window & typeof globalThis;
    // jsdom has no matchMedia, which is the thing the pointer guard asks.
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({ matches: query.includes('any-pointer: fine') ? fine : false }),
      configurable: true,
    });
    dom.window.eval(SCRIPT_BODY);
    return dom.window;
  };
  const page = pageOf;

  /** A drag, in the four events a browser sends. */
  const drag = (window: Page, card: Element, onto: Element) => {
    const transfer = { effectAllowed: '', dropEffect: '', setData: () => undefined, getData: () => '' };
    const send = (type: string, target: Element) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event);
      return event;
    };
    send('dragstart', card);
    const over = send('dragover', onto);
    const dropped = send('drop', onto);
    return { accepted: over.defaultPrevented, dropped: dropped.defaultPrevented };
  };

  it('sets the column on the card’s own form and submits nothing else', async () => {
    const window = page(board);
    const document = window.document;
    const card = document.querySelector('.card[data-slug="two"]') as HTMLElement;
    assert.ok(card, 'the card is on the board');
    assert.equal(card.draggable, true, 'and the script marked it, because the pointer is fine');

    const select = card.querySelector('select[name="column"]') as HTMLSelectElement;
    const wanted = [...select.options].find((option) => option.value !== select.value)!;
    const onto = document.querySelector(`.col[data-column="${wanted.value}"]`) as HTMLElement;

    let posted: string | null = null;
    const form = card.querySelector('form.move') as HTMLFormElement;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      posted = new window.URLSearchParams(new window.FormData(form) as never).toString();
    });

    const { accepted } = drag(window, card, onto);
    assert.equal(accepted, true, 'the column accepted the card');
    assert.equal(select.value, wanted.value, 'and the form now says where it goes');
    assert.match(String(posted), new RegExp(`slug=two&(.*&)?column=${wanted.value}`));
  });

  it('refuses a column this card cannot go to', async () => {
    const window = page(board);
    const document = window.document;
    const card = document.querySelector('.card[data-slug="two"]') as HTMLElement;
    const select = card.querySelector('select[name="column"]') as HTMLSelectElement;
    const offered = new Set([...select.options].map((option) => option.value));
    const forbidden = [...document.querySelectorAll('.col[data-column]')].find(
      (column) => !offered.has((column as HTMLElement).dataset.column!),
    );
    assert.ok(forbidden, 'some column is not among this card’s options');
    const before = select.value;
    const { accepted } = drag(window, card, forbidden!);
    assert.equal(accepted, false);
    assert.equal(select.value, before, 'and nothing was chosen');
  });

  it('reads where the card lands off the card’s own option, not off the column', async () => {
    // The defect this is for: the answer moved from the column to the option
    // and the lookup stayed where it was, so every board fell back to "same
    // lane" and the case swimlanes exist for stopped working.
    const window = page(swimlanes);
    const document = window.document;
    const card = document.querySelector('.card[data-slug="alex-work"]') as HTMLElement;
    const laneOf = (element: Element) => (element.closest('.lane') as HTMLElement).dataset.lane;
    assert.equal(laneOf(card), 'alex');

    const bobsColumns = [...document.querySelectorAll('.col[data-column="bobs"]')];
    const inBobsLane = bobsColumns.find((column) => laneOf(column) === 'bob')!;
    const inAlexsLane = bobsColumns.find((column) => laneOf(column) === 'alex')!;

    // Dropping Bob's column in Bob's lane is where the card actually lands.
    assert.equal(drag(window, card, inBobsLane).accepted, true);
    // The same column drawn in Alex's lane would send it somewhere else.
    assert.equal(drag(window, card, inAlexsLane).accepted, false);
  });

  it('turns a field with values into a list somebody can see and filter', async () => {
    const window = page(board);
    const input = window.document.querySelector('.field.combo input') as HTMLInputElement;
    assert.ok(input, 'a field was upgraded');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(input.hasAttribute('list'), false, 'the native picker is gone, so there is only one');
    assert.equal(window.document.querySelectorAll('datalist').length, 0);

    const list = input.closest('.field')!.querySelector('.choices') as HTMLElement;
    assert.ok(list.hasAttribute('hidden'), 'shut until asked');
    input.dispatchEvent(new window.Event('focus', { bubbles: false }));
    assert.equal(list.hasAttribute('hidden'), false, 'open on focus');
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    const rows = () => [...list.querySelectorAll('li[role="option"]')].map((row) => row.textContent);
    assert.deepEqual(rows(), ['alex'], 'the values the board has');

    // Typing filters, and a word nothing matches says so rather than going
    // blank, because a list that empties looks like a list that broke.
    input.value = 'zzz';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.deepEqual(rows(), []);
    assert.equal(list.querySelector('li.none')?.textContent, 'nothing matches');
  });

  it('picks with the keyboard, and leaves a typed word alone', async () => {
    const window = page(board);
    const input = window.document.querySelector('.field.combo input') as HTMLInputElement;
    const key = (name: string) => {
      const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event;
    };
    input.dispatchEvent(new window.Event('focus', { bubbles: false }));

    key('ArrowDown');
    const highlighted = input.closest('.field')!.querySelector('li[aria-selected="true"]');
    assert.equal(highlighted?.textContent, 'alex');
    assert.equal(input.getAttribute('aria-activedescendant'), highlighted?.id);

    assert.equal(key('Enter').defaultPrevented, true, 'Enter takes the highlighted one');
    assert.equal(input.value, 'alex');
    assert.equal(input.getAttribute('aria-expanded'), 'false', 'and closes');

    // Enter on a word somebody typed is the submit it has always been, because
    // a new label is a thing somebody is allowed to invent.
    input.dispatchEvent(new window.Event('focus', { bubbles: false }));
    input.value = 'a name nobody has used';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(key('Enter').defaultPrevented, false);

    key('Escape');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
  });

  it('replaces the word under the cursor where a field holds several', async () => {
    const window = page(sheet);
    const field = [...window.document.querySelectorAll('.field.combo')].find(
      (one) => (one as HTMLElement).dataset.many === 'true',
    );
    assert.ok(field, 'the waiting-on field takes several slugs');
    const input = field!.querySelector('input') as HTMLInputElement;
    input.value = 'kept-slug ';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    const row = field!.querySelector('li[role="option"]') as HTMLElement;
    const chosen = row.textContent;
    const mousedown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(mousedown);
    assert.equal(input.value, `kept-slug ${chosen} `, 'the word beside it survived');
  });

  it('still upgrades the fields where a drag cannot happen', async () => {
    // The defect this is for: the pointer guard returned from the whole
    // script, so on a phone the fields fell back to the native datalist, which
    // is the device where that is at its worst.
    const window = page(board, { fine: false });
    const document = window.document;
    assert.equal(document.querySelectorAll('.card[draggable]').length, 0, 'no drag offered');
    assert.ok(document.querySelectorAll('.card[data-slug]').length > 0, 'though the cards are there');
    assert.ok(document.querySelectorAll('.field.combo').length > 0, 'and the fields still work');
    assert.equal(document.querySelectorAll('datalist').length, 0);
  });
});
