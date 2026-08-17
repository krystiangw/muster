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
    timeline: [],
    timelineCount: 3,
    ...fields,
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
        title: 'Withdraws stuck behind the bridge for forty minutes',
        claim: {
          agent: 'errors-loop',
          claimedAt: new Date(now.getTime() - HOUR),
          expiresAt: new Date(now.getTime() + HOUR),
          heartbeatAt: new Date(now.getTime() - 120_000),
        },
        lastActor: 'errors-loop',
        labels: ['withdraw'],
        priority: 6,
      },
      now,
    ),
    item(
      {
        slug: 'market:depth-check-eu',
        title: 'Depth check keeps timing out on the EU venue',
        lastActor: 'market-loop',
        owner: 'alex',
        priority: 3,
      },
      now,
    ),
    item(
      {
        slug: 'errors:retry-storm',
        title: 'Retry storm after the provider changed its rate limit',
        lastActor: 'errors-loop',
        stale: true,
        updatedAt: new Date(now.getTime() - 30 * HOUR),
        touchedAt: new Date(now.getTime() - 30 * HOUR),
      },
      now,
    ),
    item(
      {
        slug: 'ops:bridge-or-wait',
        title: 'Bridge the position or wait for a direct withdraw?',
        status: 'blocked',
        lastActor: 'errors-loop',
        owner: 'alex',
        priority: 7,
      },
      now,
    ),
    item(
      {
        slug: 'market:pair-listing',
        title: 'New pair listed, watcher registered',
        status: 'done',
        lastActor: 'market-loop',
        closedAt: new Date(now.getTime() - 4 * HOUR),
      },
      now,
    ),
    item(
      {
        slug: 'ops:key-rotation',
        title: 'Rotate the read link after the handover',
        status: 'done',
        lastActor: 'hygiene',
        closedAt: new Date(now.getTime() - 9 * HOUR),
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
