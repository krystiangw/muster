import type { Store } from './db.js';
import { TIMELINE_KEEP } from './hygiene.js';
import { normalizeSlug } from './ids.js';
import { ServiceError, claimItem, normalizeSearch, upsertItem, wordsFilter } from './service.js';
import {
  DEFAULT_BOARD,
  ITEM_STATUSES,
  MAX_BOARD_COLUMNS,
  TERMINAL_STATUSES,
  type BoardApply,
  type BoardColumn,
  type BoardConfig,
  type BoardMatch,
  type ItemDoc,
  type ItemStatus,
  type ProjectDoc,
} from './types.js';

/**
 * Columns are a view over items, not a second place where state lives.
 *
 * The four statuses stay four however a project lays its board out, because the
 * board that this project replaced died of exactly the opposite decision:
 * eleven statuses, copied into six files, drifting twice. A column here is a
 * name and a filter, so a team can have "Investigating", "Monitoring" and
 * "Waiting on the operator" without a single agent having to learn a new value.
 */

/** How many items a single column carries in one response. */
export const COLUMN_ITEM_LIMIT = 50;

/** How many a column shows on the page before it says "and N more". */
export const COLUMN_RENDER_LIMIT = 15;

/** How many items are read to build a board. Above this, counts are partial. */
const BOARD_SCAN_LIMIT = 1000;

export interface BoardCell {
  key: string;
  title: string;
  hint?: string;
  count: number;
  items: ItemDoc[];
  /** True when the column holds more than this response carries. */
  truncated: boolean;
}

export interface BoardRow {
  key: string;
  title: string;
  columns: BoardCell[];
}

/**
 * Narrowing the board to one person's work.
 *
 * A board that six agents write to is unreadable by the seventh unless it can
 * be asked "what is mine". Owner is the field an item is assigned to; agent is
 * whoever is actually on it, which is the claim holder, or the last writer for
 * an item nobody is holding. Those are two different questions and a board that
 * only answers one of them answers the wrong one half the time.
 */
export interface BoardFilter {
  owner?: string;
  agent?: string;
  /** One label, which is how a board of many concerns gets read one at a time. */
  label?: string;
  /** Words in the slug or the title. The board's own find. */
  q?: string;
}

export interface BoardView {
  config: BoardConfig;
  rows: BoardRow[];
  totals: Array<{ key: string; title: string; count: number }>;
  /** Items no column claimed. A board that hides work is worse than no board. */
  unplaced: number;
  scanned: number;
  partial: boolean;
  /** What the board was narrowed to, so a page can say it is not the whole board. */
  filter: BoardFilter;
}

function hasAny(values: string[] | undefined, present: string[]): boolean {
  if (!values || values.length === 0) return true;
  return values.some((value) => present.includes(value));
}

export function itemMatches(item: ItemDoc, match: BoardMatch, now: Date): boolean {
  if (match.status && match.status.length > 0 && !match.status.includes(item.status)) return false;
  if (match.labels && match.labels.length > 0 && !hasAny(match.labels, item.labels ?? [])) {
    return false;
  }
  if (match.notLabels && match.notLabels.some((label) => (item.labels ?? []).includes(label))) {
    return false;
  }
  if (match.owner && match.owner.length > 0) {
    if (item.owner === null || !match.owner.includes(item.owner)) return false;
  }
  if (match.claimed !== undefined) {
    // An expired claim is not a claim: the item is free, and a board that shows
    // it as somebody's work is the exact lie claims exist to prevent.
    const live = item.claim !== null && item.claim.expiresAt > now;
    if (live !== match.claimed) return false;
  }
  if (match.stale !== undefined && Boolean(item.stale) !== match.stale) return false;
  if (match.source && match.source.length > 0) {
    if (item.source === null || !match.source.includes(item.source)) return false;
  }
  if (match.priorityMin !== undefined && (item.priority ?? 0) < match.priorityMin) return false;
  if (match.fields) {
    for (const [key, allowed] of Object.entries(match.fields)) {
      const value = (item.fields ?? {})[key];
      if (!allowed.some((candidate) => candidate === value)) return false;
    }
  }
  return true;
}

function rowKeyFor(item: ItemDoc, rows: BoardConfig['rows']): { key: string; title: string } {
  if (rows === 'owner') {
    return item.owner
      ? { key: item.owner, title: item.owner }
      : { key: '', title: 'unassigned' };
  }
  if (rows === 'label') {
    const label = (item.labels ?? [])[0];
    return label ? { key: label, title: label } : { key: '', title: 'no label' };
  }
  return { key: '', title: '' };
}

export function boardConfigOf(project: Pick<ProjectDoc, 'board'>): BoardConfig {
  return project.board ?? DEFAULT_BOARD;
}

export function buildBoard(
  items: ItemDoc[],
  config: BoardConfig,
  now = new Date(),
  filter: BoardFilter = {},
): BoardView {
  const lanes = new Map<string, BoardRow>();
  const totals = config.columns.map((column) => ({
    key: column.key,
    title: column.title,
    count: 0,
  }));
  let unplaced = 0;

  const laneFor = (key: string, title: string): BoardRow => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const row: BoardRow = {
      key,
      title,
      columns: config.columns.map((column) => ({
        key: column.key,
        title: column.title,
        ...(column.hint ? { hint: column.hint } : {}),
        count: 0,
        items: [],
        truncated: false,
      })),
    };
    lanes.set(key, row);
    return row;
  };

  if (config.rows === 'none') laneFor('', '');

  for (const item of items) {
    // First match wins, so the board is a partition and one card never appears
    // in two columns.
    const index = config.columns.findIndex((column) => itemMatches(item, column.match, now));
    if (index === -1) {
      unplaced += 1;
      continue;
    }
    const lane = rowKeyFor(item, config.rows);
    const cell = laneFor(lane.key, lane.title).columns[index]!;
    cell.count += 1;
    if (cell.items.length < COLUMN_ITEM_LIMIT) cell.items.push(item);
    else cell.truncated = true;
    totals[index]!.count += 1;
  }

  const rows = [...lanes.values()].sort((a, b) => {
    if (a.key === b.key) return 0;
    // Unassigned sits at the bottom: it is a gap, not a person.
    if (a.key === '') return 1;
    if (b.key === '') return -1;
    return a.key.localeCompare(b.key);
  });

  return {
    config,
    rows,
    totals,
    unplaced,
    scanned: items.length,
    partial: items.length >= BOARD_SCAN_LIMIT,
    filter,
  };
}

/**
 * Whether this layout puts finished work on the board.
 *
 * Closed work is off the board unless a column asks for it, which keeps the
 * scan bounded on a project with a long history. A column with no status filter
 * asks for every status, including the closed ones: a catch-all column that
 * silently dropped finished work would be the board hiding work again.
 */
function boardShowsClosed(config: BoardConfig): boolean {
  return config.columns.some((column) => {
    const statuses = column.match.status;
    if (!statuses || statuses.length === 0) return true;
    return statuses.some((status) => status === 'done' || status === 'dropped');
  });
}

export async function loadBoard(
  store: Store,
  project: ProjectDoc,
  options: { includeClosed?: boolean } & BoardFilter = {},
): Promise<BoardView> {
  const config = boardConfigOf(project);

  const wantsClosed = options.includeClosed ?? boardShowsClosed(config);

  const query: Record<string, unknown> = { projectId: project._id };
  if (!wantsClosed) query.status = { $nin: ['done', 'dropped'] };

  const narrowed: BoardFilter = {};
  if (options.owner) {
    narrowed.owner = options.owner;
    query.owner = options.owner;
  }
  if (options.label) {
    narrowed.label = options.label;
    query.labels = options.label;
  }
  if (options.q) {
    // What was actually searched, so the box and the chip show that rather
    // than whatever arrived in the query string.
    narrowed.q = normalizeSearch(options.q);
    // The same question the item list asks. It used to be a second copy of the
    // regex here, and the two agreed by luck rather than by construction.
    const words = wordsFilter(options.q);
    if (words) query.$and = [...((query.$and as unknown[]) ?? []), words];
  }
  if (options.agent) {
    narrowed.agent = options.agent;
    // Holding it counts, and so does having been the last to write to it. An
    // agent that finished a piece of work an hour ago still wants to find it.
    //
    // The claim has to be live. An expired one is not a claim anywhere else in
    // this system, and counting it here would put somebody else's item on an
    // agent's board hours after its lease ran out.
    query.$or = [
      { 'claim.agent': options.agent, 'claim.expiresAt': { $gt: new Date() } },
      { lastActor: options.agent },
    ];
  }

  const items = (await store.items
    .find(query, { projection: { timeline: 0 } })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(BOARD_SCAN_LIMIT)
    .toArray()) as ItemDoc[];

  return buildBoard(items, config, new Date(), narrowed);
}

export interface AgentFacet {
  handle: string;
  /** What it says it is for. Empty when it never registered, or said nothing. */
  description: string;
  /** Registered in this project, rather than only seen on an item. */
  registered: boolean;
}

export interface BoardFacets {
  owners: string[];
  agents: AgentFacet[];
  /** Every label on the work this board shows, so no filter comes back empty. */
  labels: string[];
  /** Names left out for length. Zero on every project anybody actually has. */
  omitted: { owners: number; agents: number; labels: number };
}

/**
 * How many names of one kind a page will offer.
 *
 * Every agent a project registered fits under this by construction: the largest
 * plan caps a project at two hundred of them, so "all the agents" is always all
 * of them. What the ceiling is really for is the other list, the names read off
 * the items, which is bounded by nothing but the item count and can hold every
 * handle that ever wrote here, including the ones that are gone.
 */
export const FACET_LIMIT = 400;

/**
 * The people and agents a board could be narrowed to.
 *
 * Read from the work itself, plus the agents that registered. Those two are
 * different on purpose: registering is an agent declaring it is here, so it is
 * offered even before it writes anything, while a claim that expired is a
 * leftover and its holder is not. Offering a name whose board comes back empty
 * is how a filter teaches people not to trust it.
 *
 * An agent is offered with what it said it was for. On a board six loops write
 * to, `loop-3` and `loop-7` are not names, they are line numbers, and a filter
 * nobody can read is a filter nobody uses.
 *
 * Registered agents are kept ahead of the rest when the ceiling bites, because
 * a name that is only a leftover on an old item is the one worth losing first.
 */
export async function boardFacets(store: Store, project: ProjectDoc): Promise<BoardFacets> {
  // The same work the board itself scans. A layout that keeps finished work off
  // the board used to be offered the labels and owners of a year of closed
  // items: picking one narrowed the board to nothing, which is the empty filter
  // this function exists to avoid. It is also what these reads cost. The cap on
  // a project counts what is still open, so the closed items behind a board are
  // bounded by nothing, and a `distinct` over an array field has to read every
  // document behind the keys whatever it is indexed by.
  const scope: Record<string, unknown> = { projectId: project._id };
  if (!boardShowsClosed(boardConfigOf(project))) {
    scope.status = { $nin: ['done', 'dropped'] };
  }

  const [owners, labels, actors, holders, registered] = await Promise.all([
    store.items.distinct('owner', scope),
    store.items.distinct('labels', scope),
    store.items.distinct('lastActor', scope),
    store.items.distinct('claim.agent', {
      ...scope,
      'claim.expiresAt': { $gt: new Date() },
    }),
    store.agents
      .find(
        { projectId: project._id },
        { projection: { handle: 1, description: 1 }, sort: { handle: 1 } },
      )
      .toArray(),
  ]);

  const names = (values: unknown[]): string[] =>
    [
      ...new Set(
        values.filter((value): value is string => typeof value === 'string' && value !== ''),
      ),
    ].sort();

  const known = new Map<string, AgentFacet>();
  for (const agent of registered) {
    if (agent.handle === '') continue;
    known.set(agent.handle, {
      handle: agent.handle,
      description: agent.description ?? '',
      registered: true,
    });
  }
  const seen = names([...actors, ...holders]).filter((handle) => !known.has(handle));

  const ownerNames = names(owners);
  const agents = [...known.values(), ...seen.map((handle) => ({
    handle,
    description: '',
    registered: false,
  }))];

  return {
    owners: ownerNames.slice(0, FACET_LIMIT),
    labels: names(labels).slice(0, FACET_LIMIT),
    agents: agents.slice(0, FACET_LIMIT),
    omitted: {
      owners: Math.max(0, ownerNames.length - FACET_LIMIT),
      agents: Math.max(0, agents.length - FACET_LIMIT),
      labels: Math.max(0, names(labels).length - FACET_LIMIT),
    },
  };
}

/**
 * What moving an item into this column does.
 *
 * A column that says nothing gets a conservative reading of its own filter: the
 * status it asks for, the labels it requires, and the labels it excludes. That
 * covers the ordinary cases without anybody writing the same thing twice, and a
 * column can always spell it out with `apply` when the filter is cleverer than
 * the move.
 */
export function applyForColumn(column: BoardColumn): BoardApply {
  if (column.apply) return column.apply;

  const derived: BoardApply = {};
  if (column.match.status && column.match.status.length === 1) {
    derived.status = column.match.status[0];
  }
  if (column.match.labels && column.match.labels.length > 0) {
    derived.addLabels = [column.match.labels[0]!];
  }
  if (column.match.notLabels && column.match.notLabels.length > 0) {
    derived.removeLabels = [...column.match.notLabels];
  }
  // A column for one person's work is a column a move can honour, the same way
  // a column for one status is. More than one name is a question the move
  // cannot answer, so it is left to the layout to declare.
  if (column.match.owner && column.match.owner.length === 1) {
    derived.owner = column.match.owner[0]!;
  }
  // "Somebody is on it" and "nobody is on it" are the two things the statuses
  // deliberately do not carry, so a move into such a column is the claim itself.
  if (column.match.claimed === true) derived.claim = true;
  if (column.match.claimed === false) derived.release = true;
  // A move is a write and a write clears staleness, so a column for work that
  // is not stale is reachable by moving into it. Naming the operation is what
  // makes that visible: the alternative is an empty apply, which the board
  // reads as "not a destination".
  if (column.match.stale === false) derived.touch = true;
  return derived;
}

/**
 * What a column asks for that no move can bring about, in words.
 *
 * A move does what the column declares and then reports where the card
 * actually landed, which is honest and arrives too late to help: the control
 * was already offered and clicked. Four filters name things a move has no way
 * to set. Staleness belongs to hygiene, `source` to whatever mirrors the item,
 * `fields` to the system the item was imported from, and `priority_min` names
 * a range rather than a value, so there is no single number a move could write.
 *
 * A card that already satisfies such a filter can of course sit in the column;
 * it just cannot be *put* there, which makes the column a view rather than a
 * destination. Multiple statuses or owners are deliberately not on this list:
 * they are ordinary, and a card whose status is already one of the named ones
 * lands there perfectly well.
 */
export function unsatisfiableBy(column: BoardColumn): string[] {
  if (column.apply) return [];
  const reasons: string[] = [];
  // Only `stale: true`. A move goes through the ordinary upsert, and every
  // agent write clears the flag, so a column for fresh work is a column a move
  // makes true by definition. The built-in "signals" preset has exactly such a
  // column, and the first version of this rule took it off the board.
  if (column.match.stale === true) reasons.push('"stale": true, which only hygiene sets');
  if ((column.match.source ?? []).length > 0) {
    reasons.push('"source", which belongs to whatever mirrors the item');
  }
  if (column.match.priorityMin !== undefined) {
    reasons.push('"priority_min", which is a range rather than a value');
  }
  if (Object.keys(column.match.fields ?? {}).length > 0) {
    reasons.push('"fields", which came from another system');
  }
  return reasons;
}

export interface MoveResult {
  item: ItemDoc;
  /** What the move actually did, so an agent can see it rather than guess. */
  applied: BoardApply;
  /** The column the item is in now. Not always the one that was asked for. */
  landedIn: string | null;
  /** Set when the item did not end up where it was sent. */
  warning?: string;
}

/**
 * Moves an item into a column.
 *
 * Dragging a card is the one gesture every board has, and an agent that can only
 * read the board has to reverse-engineer what "Monitoring" means before it can
 * put anything there. The column already declares that, in `apply` or in its own
 * filter, so a move is: read the declaration, do those things, and say where the
 * card actually landed. It can only set what an item already has, so no move can
 * invent a state, and the four statuses stay four.
 */
/**
 * Adds and removes labels in one write, in the database.
 *
 * Never read, edit and write back the whole set: two people tagging the same
 * card in the same second would each save a set computed before the other's,
 * and one tag would vanish with nothing to show it ever existed. This is the
 * same lesson the move path already learned, so it is the same mechanism,
 * lifted out to be used by both.
 */
export const MAX_ITEM_LABELS = 20;

export async function relabelItem(
  store: Store,
  project: ProjectDoc,
  slug: string,
  change: { add?: string[]; remove?: string[] },
): Promise<ItemDoc> {
  const add = change.add ?? [];
  const remove = change.remove ?? [];
  // The cap is part of the guard, not a check before it: two people tagging a
  // card that holds nineteen would both read nineteen and both write, and the
  // item would end up outside the shape every other path enforces.
  const room =
    add.length === 0
      ? {}
      : { $expr: { $lt: [{ $size: { $ifNull: ['$labels', []] } }, MAX_ITEM_LABELS] } };
  const updated = await store.items.findOneAndUpdate(
    { projectId: project._id, slug: normalizeSlug(slug), ...room },
    [
      {
        $set: {
          labels: {
            $setUnion: [
              {
                $filter: {
                  input: { $ifNull: ['$labels', []] },
                  as: 'label',
                  cond: { $not: [{ $in: ['$$label', remove] }] },
                },
              },
              add,
            ],
          },
          updatedAt: new Date(),
        },
      },
    ],
    { returnDocument: 'after' },
  );
  if (!updated) {
    // Nothing matched, which is either no such item or a full one. Saying
    // which costs one read and saves somebody guessing why a tag vanished.
    const exists = await store.items.findOne(
      { projectId: project._id, slug: normalizeSlug(slug) },
      { projection: { labels: 1 } },
    );
    if (exists) {
      throw new ServiceError(
        409,
        'too_many_labels',
        `That item already carries ${MAX_ITEM_LABELS} labels. Remove one before adding another.`,
      );
    }
    throw new ServiceError(404, 'not_found', `No item with slug "${slug}" in this project.`);
  }
  return updated as ItemDoc;
}

export async function moveItem(
  store: Store,
  project: ProjectDoc,
  options: { slug: string; column: string; actor: string; note?: string },
): Promise<MoveResult> {
  const config = boardConfigOf(project);
  const column = config.columns.find((candidate) => candidate.key === options.column);
  if (!column) {
    throw new ServiceError(
      400,
      'no_such_column',
      `This board has no column "${options.column}". Its columns are ${config.columns
        .map((candidate) => candidate.key)
        .join(', ')}.`,
    );
  }

  const slug = normalizeSlug(options.slug);
  const before = (await store.items.findOne(
    { projectId: project._id, slug },
    // The timeline is the big field on an item and no part of a move reads it.
    { projection: { status: 1, claim: 1 } },
  )) as Pick<ItemDoc, 'status' | 'claim'> | null;
  if (!before) {
    throw new ServiceError(404, 'not_found', `No item with slug "${options.slug}" in this project.`);
  }

  const apply = applyForColumn(column);
  if (Object.keys(apply).length === 0) {
    throw new ServiceError(
      400,
      'column_has_no_move',
      `Column "${column.key}" is a view with nothing to apply, so moving an item into it would change nothing. Give the column an "apply" saying what belongs there.`,
    );
  }

  const note = options.note ?? `moved to ${column.title}`;
  const now = new Date();

  // Refused before anything is written, not after the claim is taken. Moving a
  // closed item back into a working column reopens it, and reopening costs a
  // slot like any other open item; discovering that after the claim would leave
  // a rejected request holding a lease on a closed item.
  const reopens =
    apply.status !== undefined &&
    !TERMINAL_STATUSES.includes(apply.status) &&
    TERMINAL_STATUSES.includes(before.status);
  if (reopens && project.counts.items >= project.limits.items) {
    throw new ServiceError(
      429,
      'limit_reached',
      `This project is at its limit of ${project.limits.items} open items. Close something, or claim the project to lift the caps.`,
    );
  }

  // The claim goes first because it is the step most likely to fail on somebody
  // else's account: they may be holding the item. Anything that fails after it
  // hands the lease back, so a rejected move leaves nothing behind.
  const heldByUsAlready =
    before.claim !== null &&
    before.claim.agent === options.actor &&
    new Date(before.claim.expiresAt) > now;
  let ourClaimAt: Date | null = null;

  if (apply.claim) {
    const claimed = await claimItem(store, project, slug, options.actor);
    if (!claimed.ok) {
      throw new ServiceError(
        409,
        'held',
        `"${slug}" is held by ${claimed.heldBy}, so it is already in a column for work in progress.`,
      );
    }
    if (!heldByUsAlready) ourClaimAt = claimed.item?.claim?.claimedAt ?? null;
  }

  const undoClaim = async (): Promise<void> => {
    if (!ourClaimAt) return;
    // Only the lease this move took, and only if it is still exactly that one.
    await store.items.updateOne(
      { projectId: project._id, slug, 'claim.agent': options.actor, 'claim.claimedAt': ourClaimAt },
      { $set: { claim: null } },
    );
  };

  let current: ItemDoc;
  try {
    const result = await upsertItem(store, project, {
      slug,
      actor: options.actor,
      note,
      mustExist: true,
      ...(apply.status === undefined ? {} : { status: apply.status }),
      ...(apply.owner === undefined ? {} : { owner: apply.owner }),
      ...(apply.priority === undefined ? {} : { priority: apply.priority }),
    });
    current = result.item;
  } catch (error) {
    await undoClaim();
    throw error;
  }

  // Labels are applied in the database, not computed from the snapshot above:
  // a move adds or removes its own labels and must not overwrite a label
  // somebody else set while it was in flight.
  if (apply.addLabels || apply.removeLabels) {
    const remove = apply.removeLabels ?? [];
    const add = apply.addLabels ?? [];
    const relabelled = await store.items.findOneAndUpdate(
      { projectId: project._id, slug },
      [
        {
          $set: {
            labels: {
              $setUnion: [
                {
                  $filter: {
                    input: { $ifNull: ['$labels', []] },
                    as: 'label',
                    cond: { $not: [{ $in: ['$$label', remove] }] },
                  },
                },
                add,
              ],
            },
            updatedAt: new Date(),
          },
        },
      ],
      { returnDocument: 'after' },
    );
    // Nothing to match means the item was deleted since the upsert. Returning
    // the snapshot from before would put a card on the board that no longer
    // exists, which is the same lie the upsert stage refuses to tell.
    if (!relabelled) {
      await undoClaim();
      throw new ServiceError(404, 'not_found', `No item with slug "${slug}" in this project.`);
    }
    current = relabelled as ItemDoc;
  }

  if (apply.release && before.claim) {
    // Not releaseItem: that one is an agent letting go of its own lease, and a
    // move out of "in progress" is usually somebody else deciding nobody is on
    // it. Who did it is in the timeline either way.
    //
    // Guarded on the lease this move set out to release, read before any of it
    // ran. An expired claim is free for the taking, so somebody may have
    // legitimately claimed the item since; clearing a lease that began after
    // the move did would take work away from an agent that is doing it.
    const held = before.claim;
    const released = await store.items.findOneAndUpdate(
      {
        projectId: project._id,
        slug,
        'claim.agent': held.agent,
        'claim.claimedAt': held.claimedAt,
      },
      {
        $set: { claim: null, updatedAt: new Date(), touchedAt: new Date() },
        $push: {
          timeline: {
            $each: [
              {
                at: new Date(),
                by: options.actor,
                kind: 'released' as const,
                message: `${note} (was held by ${held.agent})`,
              },
            ],
            $slice: -TIMELINE_KEEP,
          },
        },
        $inc: { timelineCount: 1 },
      },
      { returnDocument: 'after' },
    );
    if (released) {
      current = released as ItemDoc;
    } else {
      // Either somebody took the item legitimately, which is the case this
      // guard exists for, or it was deleted. Only a read tells the two apart,
      // and only on this rare path.
      const still = (await store.items.findOne(
        { projectId: project._id, slug },
        { projection: { timeline: 0 } },
      )) as ItemDoc | null;
      if (!still) {
        await undoClaim();
        throw new ServiceError(404, 'not_found', `No item with slug "${slug}" in this project.`);
      }
      current = still;
    }
  }

  const landed = config.columns.find((candidate) =>
    itemMatches(current, candidate.match, new Date()),
  );

  return {
    item: current,
    applied: apply,
    landedIn: landed?.key ?? null,
    // A column can filter on more than a move can set, and an honest board says
    // so instead of showing the card somewhere the caller did not send it.
    ...(landed?.key === column.key
      ? {}
      : {
          warning: landed
            ? `The item is in "${landed.key}", not "${column.key}": the column filters on something the move does not set.`
            : `The item matches no column now. Check the board layout.`,
        }),
  };
}

// ------------------------------------------------------------------ config

function bad(message: string): ServiceError {
  return new ServiceError(400, 'bad_board', message);
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw bad(`${field} must be an array of strings.`);
  }
  return (value as string[]).slice(0, 24).map((entry) => entry.slice(0, 64));
}

function parseMatch(raw: unknown, columnKey: string): BoardMatch {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad(`Column "${columnKey}" needs a match object.`);
  }
  const source = raw as Record<string, unknown>;
  const match: BoardMatch = {};

  const statuses = stringArray(source.status, 'status');
  if (statuses) {
    for (const status of statuses) {
      if (!ITEM_STATUSES.includes(status as ItemStatus)) {
        throw bad(
          `Column "${columnKey}" filters on status "${status}", which does not exist. The statuses are ${ITEM_STATUSES.join(', ')}; anything finer belongs in a label or in fields.`,
        );
      }
    }
    match.status = statuses as ItemStatus[];
  }

  const labels = stringArray(source.labels, 'labels');
  if (labels) match.labels = labels;
  const notLabels = stringArray(source.not_labels ?? source.notLabels, 'not_labels');
  if (notLabels) match.notLabels = notLabels;
  const owner = stringArray(source.owner, 'owner');
  if (owner) match.owner = owner;
  const sources = stringArray(source.source, 'source');
  if (sources) match.source = sources;

  if (source.claimed !== undefined) {
    if (typeof source.claimed !== 'boolean') throw bad('claimed must be true or false.');
    match.claimed = source.claimed;
  }
  if (source.stale !== undefined) {
    if (typeof source.stale !== 'boolean') throw bad('stale must be true or false.');
    match.stale = source.stale;
  }
  const priorityMin = source.priority_min ?? source.priorityMin;
  if (priorityMin !== undefined) {
    if (typeof priorityMin !== 'number' || !Number.isInteger(priorityMin)) {
      throw bad('priority_min must be an integer.');
    }
    match.priorityMin = Math.max(-10, Math.min(10, priorityMin));
  }
  if (source.fields !== undefined) {
    if (typeof source.fields !== 'object' || source.fields === null || Array.isArray(source.fields)) {
      throw bad('fields must be an object of field name to a list of accepted values.');
    }
    const fields: Record<string, Array<string | number | boolean>> = {};
    for (const [key, value] of Object.entries(source.fields as Record<string, unknown>)) {
      const allowed = Array.isArray(value) ? value : [value];
      if (allowed.some((entry) => !['string', 'number', 'boolean'].includes(typeof entry))) {
        throw bad(`fields.${key} accepts strings, numbers or booleans.`);
      }
      fields[key.slice(0, 64)] = allowed.slice(0, 24) as Array<string | number | boolean>;
    }
    match.fields = fields;
  }
  return match;
}

function parseApply(raw: unknown, columnKey: string): BoardApply {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad(`Column "${columnKey}" has an apply that is not an object.`);
  }
  const source = raw as Record<string, unknown>;
  const apply: BoardApply = {};

  if (source.status !== undefined) {
    const status = String(source.status);
    if (!ITEM_STATUSES.includes(status as ItemStatus)) {
      throw bad(
        `Moving to "${columnKey}" cannot set status "${status}". The statuses are ${ITEM_STATUSES.join(', ')}.`,
      );
    }
    apply.status = status as ItemStatus;
  }
  const addLabels = stringArray(source.add_labels ?? source.addLabels, 'add_labels');
  if (addLabels) apply.addLabels = addLabels;
  const removeLabels = stringArray(source.remove_labels ?? source.removeLabels, 'remove_labels');
  if (removeLabels) apply.removeLabels = removeLabels;
  if (source.owner !== undefined) {
    apply.owner = source.owner === null ? null : String(source.owner).slice(0, 48);
  }
  if (source.priority !== undefined) {
    if (typeof source.priority !== 'number' || !Number.isInteger(source.priority)) {
      throw bad('apply.priority must be an integer.');
    }
    apply.priority = Math.max(-10, Math.min(10, source.priority));
  }
  if (source.claim !== undefined) {
    if (typeof source.claim !== 'boolean') throw bad('apply.claim must be true or false.');
    apply.claim = source.claim;
  }
  if (source.release !== undefined) {
    if (typeof source.release !== 'boolean') throw bad('apply.release must be true or false.');
    apply.release = source.release;
  }
  if (source.touch !== undefined) {
    // The only marker here with no false half. The others add a step a move
    // would otherwise skip; this one names the write the move already makes,
    // and every move makes it. Keeping a false would let a column count as a
    // destination on the strength of a key that promises nothing, and then
    // report touch: false on an item it had just touched.
    if (source.touch !== true) {
      throw bad('apply.touch can only be true: a move always touches the item.');
    }
    apply.touch = true;
  }
  if (apply.claim && apply.release) {
    throw bad(`Column "${columnKey}" both claims and releases; it can do one or the other.`);
  }
  return apply;
}

/**
 * What a layout is about to do that its author probably did not mean.
 *
 * Warnings, never refusals: a column is a filter, and refusing a legal filter
 * because it looks odd is how a board layout turns into a second rulebook. The
 * one that keeps happening is a column matched on a label with no status
 * constraint, standing before the column that catches finished work. Because
 * the board is a partition and the first match wins, closed items stay in it
 * forever, and the author finds out weeks later when "Waiting on the operator"
 * is full of things nobody is waiting for. It happened here on day one.
 */
export function boardWarnings(config: BoardConfig): string[] {
  const warnings: string[] = [];
  // Not "does it name a status" but "can it catch a finished one": a column
  // asking for ["open", "done"] names statuses and traps closed work exactly
  // the same, which is the bug wearing a constraint.
  const catchesTerminal = (column: BoardColumn): boolean => {
    const statuses = column.match.status ?? [];
    return statuses.length === 0 || statuses.some((status) => TERMINAL_STATUSES.includes(status));
  };

  config.columns.forEach((column, index) => {
    if ((column.match.labels ?? []).length === 0) return;
    if (!catchesTerminal(column)) return;
    // Somewhere later, a column meant for finished work. Without one, nothing
    // is being trapped: this board simply keeps closed items where they are.
    const later = config.columns.findIndex(
      (candidate, at) =>
        at > index &&
        (candidate.match.status ?? []).some((status) => TERMINAL_STATUSES.includes(status)),
    );
    if (later === -1) return;
    warnings.push(
      `"${column.title}" matches a label and can catch finished work, and it stands before "${config.columns[later]!.title}". Finished work keeps the label, so it will stay here rather than move on. Give that column "status": ["open", "blocked"].`,
    );
  });
  return warnings;
}

export function parseBoardConfig(raw: unknown): BoardConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad('A board is an object with "columns" and optional "rows".');
  }
  const source = raw as Record<string, unknown>;
  const columnsRaw = source.columns;
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0) {
    throw bad('A board needs at least one column.');
  }
  if (columnsRaw.length > MAX_BOARD_COLUMNS) {
    throw bad(
      `A board holds at most ${MAX_BOARD_COLUMNS} columns. More than that is a board nobody reads.`,
    );
  }

  const seen = new Set<string>();
  const columns: BoardColumn[] = columnsRaw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw bad(`Column ${index} is not an object.`);
    const column = entry as Record<string, unknown>;
    const title = typeof column.title === 'string' ? column.title.trim() : '';
    if (!title) throw bad(`Column ${index} needs a title.`);
    // Truncated first, then checked: two keys differing only after the cut
    // would both pass a check on the full strings and then collide in storage,
    // leaving the board with two columns nothing can tell apart.
    const key = (
      (typeof column.key === 'string' && column.key.trim()) ||
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    ).slice(0, 32);
    if (!key) throw bad(`Column "${title}" needs a key.`);
    if (seen.has(key)) throw bad(`Two columns share the key "${key}".`);
    seen.add(key);
    const hint = typeof column.hint === 'string' ? column.hint.slice(0, 120) : undefined;
    return {
      key,
      title: title.slice(0, 40),
      ...(hint ? { hint } : {}),
      match: parseMatch(column.match, key),
      ...(column.apply === undefined ? {} : { apply: parseApply(column.apply, key) }),
    };
  });

  const rows = source.rows === undefined ? 'none' : source.rows;
  if (rows !== 'none' && rows !== 'owner' && rows !== 'label') {
    throw bad('rows is "none", "owner" or "label".');
  }

  return { columns, rows };
}

/**
 * Starting points a project can take and then edit. Every one of them is
 * expressible in the same filters, which is the point: none of them needed a
 * new status.
 */
export const BOARD_PRESETS: Record<string, { title: string; description: string; config: BoardConfig }> = {
  default: {
    title: 'Simple',
    description: 'To do, in progress, blocked, done. What most projects need.',
    config: DEFAULT_BOARD,
  },
  loops: {
    title: 'Long-running loops',
    description:
      'For a fleet of agents that investigate, fix and then watch. Mirrors how our own boards actually run, with a lane per owner.',
    config: {
      rows: 'owner',
      columns: [
        {
          key: 'new',
          title: 'New',
          hint: 'nobody has picked it up',
          match: { status: ['open'], claimed: false, notLabels: ['monitoring', 'verifying'] },
        },
        {
          key: 'investigating',
          title: 'Investigating',
          hint: 'somebody holds a live claim',
          match: { status: ['open'], claimed: true },
        },
        {
          key: 'verifying',
          title: 'Verifying',
          hint: 'label: verifying',
          match: { status: ['open'], labels: ['verifying'] },
        },
        {
          key: 'monitoring',
          title: 'Monitoring',
          hint: 'label: monitoring, waiting for evidence',
          match: { status: ['open'], labels: ['monitoring'] },
        },
        { key: 'blocked', title: 'Blocked', match: { status: ['blocked'] } },
        { key: 'done', title: 'Done', match: { status: ['done'] } },
      ],
    },
  },
  signals: {
    title: 'Mirrored signals',
    description:
      'For boards fed by a scanner or an error stream, where staleness and absence matter more than assignment.',
    config: {
      rows: 'none',
      columns: [
        {
          key: 'fresh',
          title: 'Fresh',
          hint: 'seen recently, nobody on it',
          match: { status: ['open'], claimed: false, stale: false },
        },
        {
          key: 'working',
          title: 'Being worked',
          match: { status: ['open'], claimed: true },
        },
        {
          key: 'stale',
          title: 'Going stale',
          hint: 'untouched past the project’s stale window',
          match: { status: ['open'], stale: true },
        },
        { key: 'blocked', title: 'Blocked', match: { status: ['blocked'] } },
        { key: 'resolved', title: 'Resolved', match: { status: ['done'] } },
      ],
    },
  },
};
