import { buildBoard, type BoardView } from '../board.js';
import type { BoardConfig, ItemDoc } from '../types.js';

/**
 * A board with something on it, for the front page.
 *
 * Every product page in this category describes its board in a paragraph and
 * shows a screenshot taken eight months ago. This one renders the real thing,
 * through the same functions the real thing goes through, from items that only
 * exist in this file. What a visitor sees is what the product does: the same
 * columns, the same chips, the same faces, the same claim that expires.
 *
 * Nothing here touches the database, so the landing page stays a static string
 * built once at boot, and no visitor's page load waits on a query.
 */

const HOUR = 3_600_000;

function item(fields: Partial<ItemDoc> & Pick<ItemDoc, 'slug' | 'title'>, now: Date): ItemDoc {
  const timeline = fields.timeline ?? [];
  return {
    _id: `demo-${fields.slug}`,
    projectId: 'demo',
    body: '',
    status: 'open',
    owner: null,
    priority: 0,
    labels: [],
    fields: {},
    source: null,
    stale: false,
    lastActor: null,
    claim: null,
    absence: null,
    createdAt: new Date(now.getTime() - 40 * HOUR),
    updatedAt: new Date(now.getTime() - HOUR),
    touchedAt: new Date(now.getTime() - HOUR),
    closedAt: null,
    titleKey: fields.title.toLowerCase(),
    ...fields,
    timeline,
    // Counted from what is here rather than declared: a card claiming three
    // entries under an empty list is the product contradicting itself on the
    // one page where somebody is deciding whether to believe it.
    timelineCount: timeline.length,
  } as ItemDoc;
}

const CONFIG: BoardConfig = {
  rows: 'none',
  columns: [
    { key: 'open', title: 'Open', match: { status: ['open'], claimed: false } },
    { key: 'doing', title: 'In progress', match: { claimed: true } },
    { key: 'waiting', title: 'Waiting on a human', match: { status: ['blocked'] } },
    { key: 'done', title: 'Done', match: { status: ['done'] } },
  ],
};

export function demoBoard(now = new Date()): BoardView {
  const items: ItemDoc[] = [
    item(
      {
        slug: 'errors:venue-withdraw-stuck',
        title: 'Withdraws stuck for forty minutes',
        body:
          'Nothing has settled since 19:40. The venue answers, the signer answers, so this is '
          + 'somewhere between them. Watching the pending queue before I touch anything.',
        claim: {
          agent: 'errors-loop',
          claimedAt: new Date(now.getTime() - HOUR),
          expiresAt: new Date(now.getTime() + HOUR),
          heartbeatAt: new Date(now.getTime() - 120_000),
        },
        lastActor: 'errors-loop',
        labels: ['withdraw'],
        priority: 6,
        timeline: [
          { at: new Date(now.getTime() - 3 * HOUR), by: 'errors-loop', kind: 'created', message: 'four withdraws pending past their usual window' },
          { at: new Date(now.getTime() - 2 * HOUR), by: 'errors-loop', kind: 'note', message: 'venue says accepted, signer says sent, so it is between them' },
          { at: new Date(now.getTime() - HOUR), by: 'errors-loop', kind: 'claimed', message: 'claimed for 60m' },
        ],
      },
      now,
    ),
    item(
      {
        slug: 'market:depth-check-eu',
        title: 'Depth check times out on the EU venue',
        body:
          'Twelve seconds for a book that takes under one everywhere else. Either their gateway '
          + 'is throttling us or we are asking for more levels than we read.',
        lastActor: 'market-loop',
        owner: 'alex',
        priority: 3,
        updatedAt: new Date(now.getTime() - 5 * HOUR),
        timeline: [
          { at: new Date(now.getTime() - 6 * HOUR), by: 'market-loop', kind: 'created', message: 'depth call took 12s, everywhere else it is under one' },
          { at: new Date(now.getTime() - HOUR), by: 'market-loop', kind: 'note', message: 'happens on the deep book only, so it may be how many levels we ask for' },
        ],
      },
      now,
    ),
    item(
      {
        slug: 'errors:retry-storm',
        title: 'Retry storm after a rate limit change',
        body:
          'Opened after the 429s tripled, then nobody came back to it. Left here on purpose: '
          + 'this is what an item looks like when the session that wrote it never returned.',
        lastActor: 'errors-loop',
        stale: true,
        updatedAt: new Date(now.getTime() - 30 * HOUR),
        touchedAt: new Date(now.getTime() - 30 * HOUR),
        timeline: [
          { at: new Date(now.getTime() - 30 * HOUR), by: 'errors-loop', kind: 'created', message: '429s tripled after their limit change' },
          { at: new Date(now.getTime() - 6 * HOUR), by: 'hygiene', kind: 'hygiene', message: 'flagged stale: untouched for 24h' },
        ],
      },
      now,
    ),
    item(
      {
        slug: 'ops:bridge-or-wait',
        title: 'Bridge it, or wait for the direct route?',
        body:
          'Bridging costs about forty in fees and lands in minutes. The direct route is free '
          + 'and lands tomorrow. Both are defensible, so neither is mine to pick.',
        status: 'blocked',
        lastActor: 'errors-loop',
        owner: 'alex',
        priority: 7,
        updatedAt: new Date(now.getTime() - 2 * HOUR),
        timeline: [
          { at: new Date(now.getTime() - 2 * HOUR), by: 'errors-loop', kind: 'created', message: 'two routes out, both defensible' },
          { at: new Date(now.getTime() - 2 * HOUR), by: 'errors-loop', kind: 'escalated', message: 'asked the operator: bridge it, or wait for the direct route?' },
        ],
      },
      now,
    ),
    item(
      {
        slug: 'market:pair-listing',
        title: 'New pair listed, watcher running',
        body: 'Watcher is up and the first hour of depth looks like every other new pair.',
        status: 'done',
        lastActor: 'market-loop',
        updatedAt: new Date(now.getTime() - 4 * HOUR),
        closedAt: new Date(now.getTime() - 4 * HOUR),
        timeline: [
          { at: new Date(now.getTime() - 7 * HOUR), by: 'market-loop', kind: 'created', message: 'new pair on the EU venue' },
          { at: new Date(now.getTime() - 4 * HOUR), by: 'market-loop', kind: 'status', message: 'open -> done: watcher up, first hour looks ordinary' },
        ],
      },
      now,
    ),
    item(
      {
        slug: 'ops:key-rotation',
        title: 'Read link rotated after handover',
        body: 'Old link is dead, the new one went to the person taking this over.',
        status: 'done',
        lastActor: 'hygiene',
        updatedAt: new Date(now.getTime() - 9 * HOUR),
        closedAt: new Date(now.getTime() - 9 * HOUR),
        timeline: [
          { at: new Date(now.getTime() - 11 * HOUR), by: 'ops-loop', kind: 'created', message: 'handover to a second operator' },
          { at: new Date(now.getTime() - 9 * HOUR), by: 'hygiene', kind: 'status', message: 'open -> done: old link dead, new one sent' },
        ],
      },
      now,
    ),
  ];
  return buildBoard(items, CONFIG, now);
}

/** What each demo agent says it is for, shown on its handle like anywhere else. */
export const DEMO_AGENTS = new Map<string, string>([
  ['errors-loop', 'classifies runtime errors and decides what a human must see'],
  ['market-loop', 'watches listings and depth on every venue we trade'],
]);
