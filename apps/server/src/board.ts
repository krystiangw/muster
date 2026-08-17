import type { Store } from './db.js';
import { ServiceError } from './service.js';
import {
  DEFAULT_BOARD,
  ITEM_STATUSES,
  MAX_BOARD_COLUMNS,
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

export interface BoardView {
  config: BoardConfig;
  rows: BoardRow[];
  totals: Array<{ key: string; title: string; count: number }>;
  /** Items no column claimed. A board that hides work is worse than no board. */
  unplaced: number;
  scanned: number;
  partial: boolean;
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

export function buildBoard(items: ItemDoc[], config: BoardConfig, now = new Date()): BoardView {
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
  };
}

export async function loadBoard(
  store: Store,
  project: ProjectDoc,
  options: { includeClosed?: boolean } = {},
): Promise<BoardView> {
  const config = boardConfigOf(project);

  // Closed work is off the board unless a column asks for it, which keeps the
  // scan bounded on a project with a long history.
  const wantsClosed =
    options.includeClosed ??
    config.columns.some((column) =>
      (column.match.status ?? []).some((status) => status === 'done' || status === 'dropped'),
    );

  const filter: Record<string, unknown> = { projectId: project._id };
  if (!wantsClosed) filter.status = { $nin: ['done', 'dropped'] };

  const items = (await store.items
    .find(filter, { projection: { timeline: 0 } })
    .sort({ priority: -1, updatedAt: -1 })
    .limit(BOARD_SCAN_LIMIT)
    .toArray()) as ItemDoc[];

  return buildBoard(items, config);
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
    const key =
      (typeof column.key === 'string' && column.key.trim()) ||
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    if (!key) throw bad(`Column "${title}" needs a key.`);
    if (seen.has(key)) throw bad(`Two columns share the key "${key}".`);
    seen.add(key);
    const hint = typeof column.hint === 'string' ? column.hint.slice(0, 120) : undefined;
    return {
      key: key.slice(0, 32),
      title: title.slice(0, 40),
      ...(hint ? { hint } : {}),
      match: parseMatch(column.match, key),
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
