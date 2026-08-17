import type { Config } from './config.js';
import type { Store } from './db.js';
import { resolveAbsent } from './hygiene.js';
import { hashToken, isValidHandle, newId, newToken, normalizeHandle, normalizeSlug } from './ids.js';
import {
  DEFAULT_RULES,
  ESCALATION_PRIORITIES,
  ITEM_STATUSES,
  PRIORITY_RANK,
  TERMINAL_STATUSES,
  type AgentDoc,
  type ApiKeyDoc,
  type EscalationDoc,
  type EscalationPriority,
  type EscalationStatus,
  type ItemDoc,
  type ItemStatus,
  type ProjectDoc,
  type ProjectVisibility,
  type ShareDoc,
  type TimelineEntry,
  type TimelineKind,
} from './types.js';
import { TIMELINE_KEEP } from './hygiene.js';

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

function limitReached(what: string, limit: number): ServiceError {
  return new ServiceError(
    409,
    'limit_reached',
    `This project is capped at ${limit} ${what}. The cap counts what is still open, not what you have ever written, so finishing work frees room. A human claiming the project by email raises it.`,
    { limit, resource: what },
  );
}

/**
 * Input validation lives here, not in the HTTP schemas, because there is more
 * than one door. REST bodies are checked by Fastify, but MCP tool arguments
 * arrive from a model that may have invented them, and both end up in the same
 * documents. A status of "in progress" written through MCP would be invisible
 * to every query that knows only the four real statuses, so the domain layer
 * rejects it once, for everybody.
 */
function clamp(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

function badRequest(code: string, message: string): ServiceError {
  return new ServiceError(400, code, message);
}

export function normalizeUpsertInput(input: UpsertItemInput): UpsertItemInput {
  if (input.status !== undefined && !ITEM_STATUSES.includes(input.status)) {
    throw badRequest(
      'bad_status',
      `Status must be one of ${ITEM_STATUSES.join(', ')}. There is no "in progress": an item is in progress when it has a live claim.`,
    );
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || input.priority < -10 || input.priority > 10) {
      throw badRequest('bad_priority', 'Priority is an integer between -10 and 10.');
    }
  }
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== 'string')) {
      throw badRequest('bad_labels', 'Labels are an array of strings.');
    }
  }
  if (input.fields !== undefined && (typeof input.fields !== 'object' || input.fields === null)) {
    throw badRequest('bad_fields', 'Fields is an object.');
  }
  return {
    ...input,
    title: clamp(input.title, 300),
    body: clamp(input.body, 20_000),
    note: clamp(input.note, 2_000),
    owner: input.owner === undefined || input.owner === null ? input.owner : input.owner.slice(0, 48),
    source: input.source === undefined || input.source === null ? input.source : input.source.slice(0, 64),
    labels: input.labels?.slice(0, 20).map((label) => label.slice(0, 48)),
    actor: input.actor.slice(0, 48) || 'unknown-agent',
  };
}

/**
 * Words only, for the soft duplicate check. Not an identity, just a hint.
 *
 * Word order is kept. An earlier version sorted the words, which made
 * "route:venue-a->venue-b" and "route:venue-b->venue-a" look like the same ticket on
 * a real board, and a duplicate warning that fires on genuinely different work
 * is a warning agents learn to ignore.
 */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 2)
    .join(' ')
    .slice(0, 200);
}

// ---------------------------------------------------------------- projects

export interface CreatedProject {
  project: ProjectDoc;
  adminToken: string;
}

export async function createProject(
  store: Store,
  config: Config,
  input: { name?: string; description?: string },
): Promise<CreatedProject> {
  const now = new Date();
  const id = newId('p');
  const project: ProjectDoc = {
    _id: id,
    name: (input.name ?? 'Untitled project').slice(0, 120),
    description: (input.description ?? '').slice(0, 500),
    tier: 'demo',
    limits: config.tiers.demo,
    rules: { ...DEFAULT_RULES },
    readToken: newId('r', 16),
    claimedBy: null,
    claimedAt: null,
    expiresAt: new Date(now.getTime() + config.demoTtlDays * 86_400_000),
    createdAt: now,
    lastSweptAt: null,
    counts: { items: 0, agents: 0, escalations: 0 },
  };
  await store.projects.insertOne(project);

  const adminToken = newToken();
  const key: ApiKeyDoc = {
    _id: newId('k'),
    projectId: id,
    hash: hashToken(adminToken),
    name: 'bootstrap',
    role: 'admin',
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  await store.keys.insertOne({ ...key, expiresAt: project.expiresAt });

  return { project, adminToken };
}

export interface AuthContext {
  project: ProjectDoc;
  key: ApiKeyDoc;
}

export async function authenticate(store: Store, token: string): Promise<AuthContext> {
  const key = await store.keys.findOne({ hash: hashToken(token), revokedAt: null });
  if (!key) {
    throw new ServiceError(401, 'invalid_token', 'Unknown or revoked token.');
  }
  const project = await store.projects.findOne({ _id: key.projectId });
  if (!project) {
    throw new ServiceError(404, 'project_gone', 'The project this token belongs to no longer exists.');
  }
  // Best effort, deliberately not awaited on the request path, and deliberately
  // silent: a floating rejection here would fail a request that has already
  // succeeded, or take the process with it.
  void store.keys
    .updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { project, key };
}

export async function updateProject(
  store: Store,
  projectId: string,
  input: { name?: string; description?: string; visibility?: ProjectVisibility },
): Promise<ProjectDoc> {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest('bad_name', 'A project needs a name.');
    set.name = name.slice(0, 120);
  }
  if (input.description !== undefined) set.description = input.description.slice(0, 500);
  if (input.visibility !== undefined) {
    if (input.visibility !== 'link' && input.visibility !== 'owner') {
      throw badRequest('bad_visibility', 'Visibility is "link" or "owner".');
    }
    if (input.visibility === 'owner') {
      const project = await store.projects.findOne({ _id: projectId });
      if (!project?.claimedBy) {
        // Closing a project to an owner it does not have would lock everybody
        // out of it, including the agent that just created it.
        throw badRequest(
          'not_claimed',
          'Only a project somebody owns can be narrowed to its owner. Claim it by email first, or hand it over with /share.',
        );
      }
    }
    set.visibility = input.visibility;
  }

  const project = await store.projects.findOneAndUpdate(
    { _id: projectId },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!project) throw new ServiceError(404, 'not_found', 'No such project.');
  return project as ProjectDoc;
}

/**
 * Offers a project to an operator. Nothing changes for them until they accept
 * it from a view they already hold a link to, so this cannot be used to push a
 * board into somebody's queue.
 */
export async function shareProject(
  store: Store,
  project: ProjectDoc,
  input: { email: string; offeredBy?: string; note?: string },
): Promise<{ share: ShareDoc; alreadyOwned: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw badRequest('bad_email', 'That does not look like an email address.');
  }
  const now = new Date();
  if (project.claimedBy === email) {
    return {
      share: {
        _id: newId('s'),
        projectId: project._id,
        email,
        offeredBy: (input.offeredBy ?? 'unknown-agent').slice(0, 48),
        note: (input.note ?? '').slice(0, 500),
        createdAt: now,
        expiresAt: now,
      },
      alreadyOwned: true,
    };
  }
  if (project.claimedBy && project.claimedBy !== email) {
    // An offer that acceptance is guaranteed to refuse is worse than no offer:
    // the recipient finds out by clicking it.
    throw new ServiceError(
      409,
      'already_owned',
      'Somebody else already owns this project, so it cannot be offered to another person.',
    );
  }

  const share: ShareDoc = {
    _id: newId('s'),
    projectId: project._id,
    email,
    offeredBy: (input.offeredBy ?? 'unknown-agent').slice(0, 48),
    note: (input.note ?? '').slice(0, 500),
    createdAt: now,
    // An offer nobody accepted is not worth keeping around for ever.
    expiresAt: new Date(now.getTime() + 30 * 86_400_000),
  };

  // Offering the same board twice refreshes the note rather than failing: the
  // id and the creation time belong to the first offer, and MongoDB refuses to
  // change an _id on an existing document anyway.
  const result = await store.shares.findOneAndUpdate(
    { projectId: project._id, email },
    {
      $set: {
        offeredBy: share.offeredBy,
        note: share.note,
        expiresAt: share.expiresAt,
      },
      $setOnInsert: {
        _id: share._id,
        projectId: share.projectId,
        email: share.email,
        createdAt: share.createdAt,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return { share: (result ?? share) as ShareDoc, alreadyOwned: false };
}

export async function acceptShare(
  store: Store,
  config: Config,
  email: string,
  shareId: string,
): Promise<ProjectDoc> {
  const share = await store.shares.findOne({ _id: shareId, email });
  if (!share) throw new ServiceError(404, 'not_found', 'No such offer.');
  const project = await store.projects.findOne({ _id: share.projectId });
  if (!project) {
    await store.shares.deleteOne({ _id: shareId });
    throw new ServiceError(404, 'project_gone', 'That project no longer exists.');
  }
  if (project.claimedBy && project.claimedBy !== email) {
    await store.shares.deleteOne({ _id: shareId });
    throw new ServiceError(409, 'already_owned', 'Somebody else already owns that project.');
  }

  // Two people accepting offers for the same board at the same moment both read
  // it as unowned, so ownership is taken with a condition rather than a plain
  // write: the second one is told, instead of quietly taking it away.
  const taken = await store.projects.updateOne(
    { _id: project._id, $or: [{ claimedBy: null }, { claimedBy: email }] },
    { $set: { claimedBy: email } },
  );
  if (taken.matchedCount === 0) {
    await store.shares.deleteOne({ _id: shareId });
    throw new ServiceError(409, 'already_owned', 'Somebody else took that project first.');
  }

  await claimProjectWithEmail(store, project, email, config);
  await store.shares.deleteMany({ projectId: project._id });
  return (await store.projects.findOne({ _id: project._id })) as ProjectDoc;
}

export async function claimProjectWithEmail(
  store: Store,
  project: ProjectDoc,
  email: string,
  config: Config,
): Promise<void> {
  const now = new Date();
  // Guarded, because ownership is not a field anybody may overwrite. An
  // unguarded $set let a second claim move a live project to another address,
  // and the previous owner simply stopped seeing it in their operator view.
  // Unowned, or already this person's: everything else is a conflict.
  const taken = await store.projects.updateOne(
    { _id: project._id, $or: [{ claimedBy: null }, { claimedBy: email }] },
    {
      $set: {
        claimedBy: email,
        claimedAt: now,
        expiresAt: null,
        tier: 'free',
        limits: config.tiers.free,
      },
    },
  );
  if (taken.matchedCount === 0) {
    throw new ServiceError(
      409,
      'already_owned',
      'Somebody else already owns this project. Ask them to hand it over rather than claiming it again.',
    );
  }
  // Children carry their own TTL so the sweep needs no orphan pass; clearing it
  // here is the one bulk write a project ever needs.
  const clear = { $set: { expiresAt: null } };
  await Promise.all([
    store.items.updateMany({ projectId: project._id }, clear),
    store.agents.updateMany({ projectId: project._id }, clear),
    store.escalations.updateMany({ projectId: project._id }, clear),
    store.keys.updateMany({ projectId: project._id }, clear),
  ]);
}

// ------------------------------------------------------------------ agents

export async function registerAgent(
  store: Store,
  project: ProjectDoc,
  input: { handle: string; scope?: string[]; description?: string; meta?: Record<string, unknown> },
): Promise<{ agent: AgentDoc; created: boolean }> {
  const handle = normalizeHandle(input.handle ?? '');
  if (!isValidHandle(handle)) {
    throw badRequest(
      'bad_handle',
      'A handle is lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.',
    );
  }
  if (input.scope !== undefined) {
    if (!Array.isArray(input.scope) || input.scope.some((token) => typeof token !== 'string')) {
      throw badRequest('bad_scope', 'Scope is an array of strings.');
    }
  }
  const now = new Date();
  const existing = await store.agents.findOne({ projectId: project._id, handle });
  if (!existing && project.counts.agents >= project.limits.agents) {
    throw limitReached('agents', project.limits.agents);
  }

  const result = await store.agents.findOneAndUpdate(
    { projectId: project._id, handle },
    {
      $set: {
        lastSeenAt: now,
        ...(input.scope ? { scope: input.scope.slice(0, 32).map((s) => s.slice(0, 96)) } : {}),
        ...(input.description !== undefined ? { description: input.description.slice(0, 500) } : {}),
        ...(input.meta ? { meta: input.meta } : {}),
      },
      $setOnInsert: {
        _id: newId('a'),
        projectId: project._id,
        handle,
        registeredAt: now,
        expiresAt: project.expiresAt,
        ...(input.scope ? {} : { scope: [] }),
        ...(input.description !== undefined ? {} : { description: '' }),
        ...(input.meta ? {} : { meta: {} }),
      },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true },
  );

  const created = !result.lastErrorObject?.updatedExisting;
  if (created) {
    await store.projects.updateOne({ _id: project._id }, { $inc: { 'counts.agents': 1 } });
  }
  return { agent: result.value as AgentDoc, created };
}

/**
 * Records that an agent was alive. Every caller fires this and walks away, so
 * it swallows its own failures: a heartbeat timestamp is not worth failing a
 * write that already succeeded, and a floating rejection takes the whole
 * process down under Node's default handling.
 */
export async function touchAgent(store: Store, projectId: string, handle: string): Promise<void> {
  if (!handle) return;
  try {
    await store.agents.updateOne({ projectId, handle }, { $set: { lastSeenAt: new Date() } });
  } catch {
    // Deliberately silent.
  }
}

/**
 * Advisory scope matching. A scope token matches an item when it is a prefix of
 * the slug, one of its labels, or its owner. Nothing here blocks a write: the
 * incident that motivated it was solved socially, by making the boundary
 * visible, not by locking agents out of each other's tickets.
 */
export function itemInScope(scope: string[], item: Pick<ItemDoc, 'slug' | 'labels' | 'owner'>): boolean {
  if (scope.length === 0) return true;
  return scope.some(
    (token) =>
      item.slug.startsWith(token) ||
      item.labels.includes(token) ||
      (item.owner !== null && item.owner === token),
  );
}

// ------------------------------------------------------------------- items

export interface UpsertItemInput {
  slug: string;
  title?: string;
  body?: string;
  owner?: string | null;
  status?: ItemStatus;
  priority?: number;
  labels?: string[];
  fields?: Record<string, unknown>;
  source?: string | null;
  note?: string;
  actor: string;
  /**
   * Timeline entries carried over from another system, with their original
   * timestamps and authors. Migrating a board without its history throws away
   * the only thing that made the board worth having, so this exists; it is
   * admin-only, because backdating somebody else's words is not a worker's job.
   */
  history?: Array<{ at: string | Date; by?: string; message: string }>;
  /**
   * Refuse to create the item, with a 404 instead. Every ordinary write to a
   * slug means "make this true", and creating it is right. A board move means
   * "put that card in this column", and if the card was deleted while the move
   * was in flight, recreating it as a blank item is a worse answer than saying
   * it is gone.
   */
  mustExist?: boolean;
}

export interface UpsertItemResult {
  item: ItemDoc;
  created: boolean;
  warnings: string[];
}

export async function upsertItem(
  store: Store,
  project: ProjectDoc,
  rawInput: UpsertItemInput,
): Promise<UpsertItemResult> {
  const input = normalizeUpsertInput(rawInput);
  const slug = normalizeSlug(input.slug);
  if (!slug) {
    throw new ServiceError(400, 'bad_slug', 'slug must contain at least one alphanumeric character.');
  }
  const now = new Date();
  const warnings: string[] = [];

  // Parsed before anything is written. A bad timestamp buried in a hundred
  // carried entries must not surface as a 400 after the item has already
  // changed status and moved the project's counters.
  const carriedHistory = (input.history ?? [])
    .map((entry) => {
      const at = entry.at instanceof Date ? entry.at : new Date(entry.at);
      if (Number.isNaN(at.getTime())) {
        throw badRequest('bad_history', 'Every history entry needs a valid "at" timestamp.');
      }
      return {
        at,
        by: (entry.by ?? 'imported').slice(0, 48),
        kind: 'note' as const,
        message: String(entry.message ?? '').slice(0, 4000),
      };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const existing = await store.items.findOne(
    { projectId: project._id, slug },
    { projection: { _id: 1, status: 1, title: 1 } },
  );

  /**
   * Capacity accounting.
   *
   * The cap counts open items, not slugs ever written, so a project that has
   * closed a thousand tickets is not bricked. Two rules keep it honest, and one
   * deliberate imprecision keeps it safe:
   *
   *  - only the request that actually performs a status transition accounts for
   *    it. Two agents closing the same item both believe they closed it, and
   *    two decrements for one closure drive the counter below zero, so the
   *    transition is taken with the previous status as a guard;
   *  - reopening a closed item costs a slot, or the cap is one `done` and one
   *    `open` away from meaningless;
   *  - **the counter moves after the write succeeds, never before it.** An
   *    earlier version reserved the slot first, which is exact under
   *    concurrency and wrong under failure: a process dying between the
   *    reservation and the insert leaves a slot charged to nobody. Charging
   *    afterwards means a crash on the create path hands out an extra slot
   *    instead, which is the harmless direction. The cost is that a burst of
   *    simultaneous creates can overshoot the cap by roughly the size of the
   *    burst before the next one is refused.
   *
   * That still leaves one way to drift the wrong way: closing or deleting
   * changes the document first and gives the slot back second, so a crash in
   * between overcounts. `correctOvercount` in the sweep lowers a counter to a
   * number it has actually seen, and never raises one.
   */
  const addSlots = async (delta: number): Promise<void> => {
    if (delta === 0) return;
    await store.projects.updateOne({ _id: project._id }, { $inc: { 'counts.items': delta } });
  };
  const atCapacity = (): boolean => project.counts.items >= project.limits.items;

  const wasTerminal = existing ? TERMINAL_STATUSES.includes(existing.status) : false;
  const willBeTerminal = input.status !== undefined && TERMINAL_STATUSES.includes(input.status);
  const changesStatus =
    existing !== null && input.status !== undefined && input.status !== existing.status;

  let ownsTransition = false;
  let applyStatus = input.status !== undefined;

  if (!existing) {
    if (input.mustExist) throw notFound(slug);
    if (!willBeTerminal && atCapacity()) {
      throw limitReached('open items', project.limits.items);
    }
    if (input.title) {
      const key = titleKey(input.title);
      if (key) {
        const twin = await store.items.findOne(
          { projectId: project._id, titleKey: key, status: { $nin: [...TERMINAL_STATUSES] } },
          { projection: { slug: 1 } },
        );
        if (twin) {
          warnings.push(
            `An open item with the same title already exists under slug "${twin.slug}". If it is the same thing, write to that slug instead.`,
          );
        }
      }
    }
  } else if (changesStatus) {
    // Reopening costs a slot, so it is refused at the cap like a new item.
    if (wasTerminal && !willBeTerminal && atCapacity()) {
      throw limitReached('open items', project.limits.items);
    }

    // The previous status is the guard, so exactly one of several concurrent
    // requests owns the transition and only that one moves the counter.
    const moved = await store.items.findOneAndUpdate(
      { projectId: project._id, slug, status: existing.status },
      {
        $set: {
          status: input.status!,
          closedAt: willBeTerminal ? now : null,
          updatedAt: now,
        },
      },
      { projection: { _id: 1 } },
    );
    ownsTransition = moved !== null;

    if (!ownsTransition) {
      // Somebody else moved it first, and their status is the one that stands.
      applyStatus = false;
    } else if (wasTerminal !== willBeTerminal) {
      await addSlots(willBeTerminal ? -1 : 1);
    }
  }

  const set: Record<string, unknown> = { updatedAt: now, touchedAt: now };
  const setOnInsert: Record<string, unknown> = {
    _id: newId('i'),
    projectId: project._id,
    slug,
    createdAt: now,
    absence: { count: 0, since: null },
    claim: null,
    expiresAt: project.expiresAt,
  };

  const assign = <T>(field: string, value: T | undefined, fallback: T): void => {
    if (value === undefined) setOnInsert[field] = fallback;
    else set[field] = value;
  };

  assign('title', input.title, '');
  assign('body', input.body, '');
  assign('owner', input.owner, null);
  assign('priority', input.priority, 0);
  assign('labels', input.labels, []);
  assign('fields', input.fields, {});
  assign('source', input.source, null);

  if (input.title !== undefined) set.titleKey = titleKey(input.title);
  else setOnInsert.titleKey = '';

  // Any write by an agent is proof of life: it clears the stale flag that the
  // hygiene engine may have set. Hygiene marks, agents unmark, and neither
  // needs to know about the other.
  set.stale = false;
  set.staleSince = null;
  set.lastActor = input.actor;

  const status = applyStatus ? input.status : undefined;
  if (!existing) {
    if (status !== undefined) {
      set.status = status;
      set.closedAt = TERMINAL_STATUSES.includes(status) ? now : null;
    } else {
      setOnInsert.status = 'open';
      setOnInsert.closedAt = null;
    }
  }
  // For an item that already exists, the status is never written here. The
  // guarded transition above already applied it, and repeating it unguarded
  // would let a slow request overwrite a newer one: A closes, B reopens, then
  // A's second write closes it again while the counter still reflects B.

  const entries: TimelineEntry[] = [];
  if (carriedHistory.length > 0 && !existing) {
    // Only on the first write of a slug. A migration re-run after a failure
    // would otherwise append the same history again, which is exactly the
    // duplication the slug exists to prevent.
    //
    // The document keeps a bounded timeline, so a longer history is truncated
    // to its most recent entries and the caller is told, rather than being let
    // to believe everything was stored.
    const room = TIMELINE_KEEP - 1;
    const kept = carriedHistory.slice(-room);
    if (kept.length < carriedHistory.length) {
      warnings.push(
        `Kept the ${kept.length} most recent of ${carriedHistory.length} carried timeline entries; an item holds ${TIMELINE_KEEP}.`,
      );
    }
    entries.push(...kept);
  }
  if (!existing) {
    entries.push({ at: now, by: input.actor, kind: 'created', message: input.note ?? 'created' });
  } else {
    if (ownsTransition && status !== undefined) {
      entries.push({
        at: now,
        by: input.actor,
        kind: 'status',
        message: `${existing.status} -> ${status}${input.note ? `: ${input.note}` : ''}`,
      });
    } else if (input.note) {
      entries.push({ at: now, by: input.actor, kind: 'note', message: input.note });
    } else {
      entries.push({ at: now, by: input.actor, kind: 'updated', message: 'updated' });
    }
  }

  const write = () =>
    store.items.findOneAndUpdate(
      { projectId: project._id, slug },
      {
        $set: set,
        $setOnInsert: setOnInsert,
        $push: { timeline: { $each: entries, $slice: -TIMELINE_KEEP } },
        $inc: { timelineCount: entries.length },
      },
      {
        upsert: input.mustExist !== true,
        returnDocument: 'after',
        includeResultMetadata: true,
      },
    );

  let result;
  try {
    result = await write();
  } catch (error) {
    // Two agents filing the same new slug in the same instant is the normal
    // case here, not an edge case, and MongoDB documents that concurrent
    // upserts against a unique index can surface E11000. The retry finds the
    // document the other writer just inserted and updates it, which is exactly
    // what convergence on a slug is supposed to mean.
    if ((error as { code?: number }).code !== 11000) throw error;
    delete setOnInsert._id;
    result = await write();
  }

  // Only reachable with mustExist: without it the write upserts and always
  // returns a document. The item was deleted between the lookup above and here.
  if (!result.value) throw notFound(slug);

  const created = !result.lastErrorObject?.updatedExisting;
  const item = result.value as ItemDoc;
  const isTerminal = TERMINAL_STATUSES.includes(item.status);

  // Transitions accounted for themselves above, under the guard that decides
  // who owns them. A creation charges its slot here, after the insert has
  // actually happened.
  if (created && !isTerminal) {
    await addSlots(1);
  }

  void touchAgent(store, project._id, input.actor);
  return { item, created, warnings };
}

export async function appendNote(
  store: Store,
  project: ProjectDoc,
  slug: string,
  actor: string,
  message: string,
  kind: TimelineKind = 'note',
): Promise<ItemDoc> {
  const now = new Date();
  const entry: TimelineEntry = { at: now, by: actor, kind, message };
  const item = await store.items.findOneAndUpdate(
    { projectId: project._id, slug: normalizeSlug(slug) },
    {
      $set: { updatedAt: now, touchedAt: now, stale: false, staleSince: null, lastActor: actor },
      $push: { timeline: { $each: [entry], $slice: -TIMELINE_KEEP } },
      $inc: { timelineCount: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!item) throw notFound(slug);
  void touchAgent(store, project._id, actor);
  return item as ItemDoc;
}

function notFound(slug: string): ServiceError {
  return new ServiceError(404, 'not_found', `No item with slug "${slug}" in this project.`);
}

export interface ClaimResult {
  ok: boolean;
  item: ItemDoc | null;
  heldBy?: string;
  expiresAt?: Date;
}

export async function claimItem(
  store: Store,
  project: ProjectDoc,
  slug: string,
  agent: string,
  ttlMinutes?: number,
): Promise<ClaimResult> {
  const now = new Date();
  const ttl = Math.min(Math.max(ttlMinutes ?? project.rules.claimTtlMinutes, 1), 1440);
  const expiresAt = new Date(now.getTime() + ttl * 60_000);
  const normalized = normalizeSlug(slug);

  const claimed = await store.items.findOneAndUpdate(
    {
      projectId: project._id,
      slug: normalized,
      $or: [
        { claim: null },
        { 'claim.expiresAt': { $lte: now } },
        { 'claim.agent': agent },
      ],
    },
    {
      $set: {
        claim: { agent, claimedAt: now, heartbeatAt: now, expiresAt },
        updatedAt: now,
        touchedAt: now,
        stale: false,
        staleSince: null,
        lastActor: agent,
      },
      $push: {
        timeline: {
          $each: [{ at: now, by: agent, kind: 'claimed' as const, message: `claimed for ${ttl}m` }],
          $slice: -TIMELINE_KEEP,
        },
      },
      $inc: { timelineCount: 1 },
    },
    { returnDocument: 'after' },
  );

  if (claimed) {
    void touchAgent(store, project._id, agent);
    return { ok: true, item: claimed as ItemDoc, expiresAt };
  }

  const current = await store.items.findOne({ projectId: project._id, slug: normalized });
  if (!current) throw notFound(slug);
  return { ok: false, item: current as ItemDoc, heldBy: current.claim?.agent ?? 'unknown' };
}

export async function heartbeatClaim(
  store: Store,
  project: ProjectDoc,
  slug: string,
  agent: string,
  ttlMinutes?: number,
): Promise<ItemDoc> {
  const now = new Date();
  const ttl = Math.min(Math.max(ttlMinutes ?? project.rules.claimTtlMinutes, 1), 1440);
  const item = await store.items.findOneAndUpdate(
    {
      projectId: project._id,
      slug: normalizeSlug(slug),
      'claim.agent': agent,
      // A lapsed lease cannot be extended, only re-taken. Between expiry and
      // the sweep that clears it, the item is already fair game for everybody
      // else, and letting the old holder quietly extend would hand it back
      // after it was released.
      'claim.expiresAt': { $gt: now },
    },
    {
      $set: {
        'claim.heartbeatAt': now,
        'claim.expiresAt': new Date(now.getTime() + ttl * 60_000),
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (!item) {
    throw new ServiceError(
      409,
      'not_claim_holder',
      `You do not hold a live claim on "${slug}". Claim it again if the previous one expired.`,
    );
  }
  return item as ItemDoc;
}

export async function releaseItem(
  store: Store,
  project: ProjectDoc,
  slug: string,
  agent: string,
  note?: string,
): Promise<ItemDoc> {
  const now = new Date();
  const item = await store.items.findOneAndUpdate(
    { projectId: project._id, slug: normalizeSlug(slug), 'claim.agent': agent },
    {
      $set: { claim: null, updatedAt: now, touchedAt: now, lastActor: agent },
      $push: {
        timeline: {
          $each: [
            { at: now, by: agent, kind: 'released' as const, message: note ?? 'released' },
          ],
          $slice: -TIMELINE_KEEP,
        },
      },
      $inc: { timelineCount: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!item) {
    throw new ServiceError(409, 'not_claim_holder', `You do not hold the claim on "${slug}".`);
  }
  return item as ItemDoc;
}

/**
 * Removes an item outright. Closing is the normal end of a piece of work and
 * keeps the audit trail; deleting exists for the mistakes, the imports that
 * went wrong and the data somebody needs gone.
 */
export async function deleteItem(
  store: Store,
  project: ProjectDoc,
  slug: string,
): Promise<void> {
  const deleted = await store.items.findOneAndDelete({
    projectId: project._id,
    slug: normalizeSlug(slug),
  });
  if (!deleted) throw notFound(slug);
  if (!TERMINAL_STATUSES.includes(deleted.status)) {
    await store.projects.updateOne({ _id: project._id }, { $inc: { 'counts.items': -1 } });
  }
}

/**
 * Most urgent first, an order that cannot move under a long read, or the order
 * a change feed needs: whatever happened last, first.
 */
export type ItemOrder = 'urgency' | 'id' | 'recent';

export interface ListItemsQuery {
  status?: ItemStatus;
  owner?: string;
  label?: string;
  source?: string;
  stale?: boolean;
  claimed?: boolean;
  limit?: number;
  includeTimeline?: boolean;
  order?: ItemOrder;
  /** From a previous page's `next_cursor`, read in the same order. */
  cursor?: string;
  /**
   * Only what changed at or after this moment. Pass back the `as_of` from the
   * previous read: your own clock is not the one that stamped these rows.
   */
  since?: Date;
}

/**
 * The cursor for a page of items.
 *
 * Two orders, because they answer different questions and one of them cannot
 * answer the other honestly:
 *
 *  - `urgency` is what an agent browsing wants: the most urgent first. Its
 *    cursor carries the whole sort key, since priority and updatedAt both tie
 *    constantly and a cursor on one field alone skips every row that ties.
 *  - `id` is what an export wants: an order nothing can reshuffle underneath
 *    you. Priority and updatedAt change while you read, so a long scan in
 *    urgency order can miss an item that moved behind the cursor, and an
 *    import nobody can verify is exactly what a migration must not have.
 */
export function itemCursor(doc: ItemDoc, order: ItemOrder): string {
  if (order === 'id') return doc._id;
  if (order === 'recent') return `${doc.updatedAt.toISOString()}|${doc._id}`;
  return `${doc.priority}|${doc.updatedAt.toISOString()}|${doc._id}`;
}

function afterCursor(cursor: string, order: ItemOrder): Record<string, unknown> | null {
  if (order === 'recent') {
    // Both halves, because several writes land in the same millisecond all the
    // time and a cursor on the timestamp alone skips every one of them but the
    // first, which in a change feed means work that silently never arrives.
    const at = cursor.lastIndexOf('|');
    if (at === -1) return null;
    const when = new Date(cursor.slice(0, at));
    const id = cursor.slice(at + 1);
    if (Number.isNaN(when.getTime()) || id === '') return null;
    return {
      $or: [{ updatedAt: { $lt: when } }, { updatedAt: when, _id: { $lt: id } }],
    };
  }
  if (order === 'id') {
    // An id cursor is opaque but not shapeless. Accepting anything here would
    // turn an urgency cursor passed to the wrong order into an empty page,
    // and an empty page is how a verification run concludes, wrongly, that it
    // has read everything.
    return /^i_[a-z0-9]+$/.test(cursor) ? { _id: { $gt: cursor } } : null;
  }
  const parts = cursor.split('|');
  if (parts.length < 3) return null;
  const priority = Number(parts[0]);
  const updatedAt = new Date(parts[1]!);
  const id = parts.slice(2).join('|');
  if (!Number.isFinite(priority) || Number.isNaN(updatedAt.getTime())) return null;
  return {
    $or: [
      { priority: { $lt: priority } },
      { priority, updatedAt: { $lt: updatedAt } },
      { priority, updatedAt, _id: { $lt: id } },
    ],
  };
}

export async function listItems(
  store: Store,
  projectId: string,
  query: ListItemsQuery,
): Promise<ItemDoc[]> {
  const filter: Record<string, unknown> = { projectId };
  if (query.status) filter.status = query.status;
  if (query.owner) filter.owner = query.owner;
  if (query.label) filter.labels = query.label;
  if (query.source) filter.source = query.source;
  if (query.stale !== undefined) filter.stale = query.stale;
  if (query.claimed === true) filter.claim = { $ne: null };
  if (query.claimed === false) filter.claim = null;

  const order: ItemOrder =
    query.order === 'id' ? 'id' : query.order === 'recent' ? 'recent' : 'urgency';
  const conditions: Record<string, unknown>[] = [];
  if (query.since) conditions.push({ updatedAt: { $gte: query.since } });
  if (query.cursor) {
    const after = afterCursor(query.cursor, order);
    if (!after) {
      throw new ServiceError(
        400,
        'bad_cursor',
        'That cursor does not belong to this order. Pass back the next_cursor you were given, with the same order=.',
      );
    }
    conditions.push(after);
  }
  // Both can constrain updatedAt, so they go side by side rather than one
  // quietly overwriting the other on the way into the filter.
  if (conditions.length === 1) Object.assign(filter, conditions[0]);
  else if (conditions.length > 1) filter.$and = conditions;

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const projection = query.includeTimeline ? undefined : { timeline: 0 };
  const sort: Record<string, 1 | -1> =
    order === 'id'
      ? { _id: 1 }
      : order === 'recent'
        ? { updatedAt: -1, _id: -1 }
        : { priority: -1, updatedAt: -1, _id: -1 };
  return store.items
    .find(filter, projection ? { projection } : {})
    .sort(sort)
    .limit(limit)
    .toArray() as Promise<ItemDoc[]>;
}

export async function getItem(
  store: Store,
  projectId: string,
  slug: string,
): Promise<ItemDoc> {
  const item = await store.items.findOne({ projectId, slug: normalizeSlug(slug) });
  if (!item) throw notFound(slug);
  return item as ItemDoc;
}

export interface NextResult {
  item: ItemDoc | null;
  reason: string;
}

/**
 * What should this agent pick up next.
 *
 * Scope first: an agent with a declared scope is offered its own work before
 * anyone else's, and if there is none it is told so rather than handed a
 * neighbour's ticket. That is the whole fix for the scope drift that cost two
 * strikes and an operator escalation on the board this one replaces.
 */
export async function nextItem(
  store: Store,
  project: ProjectDoc,
  handle: string,
): Promise<NextResult> {
  const now = new Date();
  const agent = handle ? await store.agents.findOne({ projectId: project._id, handle }) : null;

  // Your own live claim comes first. A session that restarts and asks what to do
  // must be handed back the work it already took, otherwise it abandons a
  // claimed item and blocks it until the lease expires.
  if (handle) {
    const own = await store.items.findOne({
      projectId: project._id,
      status: 'open',
      'claim.agent': handle,
      'claim.expiresAt': { $gt: now },
    });
    if (own) {
      return { item: own as ItemDoc, reason: 'you already hold this claim, finish or release it' };
    }
  }

  const base = {
    projectId: project._id,
    status: 'open' as const,
    $or: [{ claim: null }, { 'claim.expiresAt': { $lte: now } }],
  };
  const sort = { priority: -1 as const, touchedAt: 1 as const };

  const scope = agent?.scope ?? [];
  if (scope.length > 0) {
    const scoped = await store.items
      .find({
        ...base,
        $and: [
          {
            $or: [
              { labels: { $in: scope } },
              { owner: { $in: scope } },
              { slug: { $in: scope } },
              ...scope.map((token) => ({ slug: { $regex: `^${escapeRegex(token)}` } })),
            ],
          },
        ],
      })
      .sort(sort)
      .limit(1)
      .toArray();
    if (scoped[0]) return { item: scoped[0] as ItemDoc, reason: 'in your declared scope' };

    const otherCount = await store.items.countDocuments(base, { limit: 50 });
    return {
      item: null,
      reason:
        otherCount > 0
          ? `nothing open in your scope; ${otherCount} open item(s) belong to other scopes. Widen your scope on purpose, or leave them alone.`
          : 'nothing open in this project',
    };
  }

  const any = await store.items.find(base).sort(sort).limit(1).toArray();
  return any[0]
    ? { item: any[0] as ItemDoc, reason: 'oldest untouched open item' }
    : { item: null, reason: 'nothing open in this project' };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------------ observe

export interface ObserveResult {
  present: number;
  absent: number;
  resolved: number;
}

/**
 * Reports which items of a mirrored source are still present. Everything else
 * from that source starts, or continues, an absence streak. This is the
 * generic form of the audit-sync it replaces, and the reason the absence rule
 * can be a rule instead of a bespoke service.
 */
export async function observe(
  store: Store,
  project: ProjectDoc,
  source: string,
  presentSlugs: string[],
): Promise<ObserveResult> {
  const now = new Date();
  const present = presentSlugs.map(normalizeSlug).filter(Boolean);

  const reset = await store.items.updateMany(
    { projectId: project._id, source, slug: { $in: present } },
    { $set: { 'absence.count': 0, 'absence.since': null } },
  );

  const absent = await store.items.updateMany(
    { projectId: project._id, source, slug: { $nin: present }, status: 'open' },
    [
      {
        $set: {
          absence: {
            count: { $add: [{ $ifNull: ['$absence.count', 0] }, 1] },
            since: { $ifNull: ['$absence.since', now] },
          },
        },
      },
    ],
  );

  const outcome = await resolveAbsent(store, project._id, project.rules, now);
  return {
    present: reset.modifiedCount,
    absent: absent.modifiedCount,
    resolved: outcome.affected,
  };
}

// -------------------------------------------------------------- escalations

/**
 * An agent saying it has acted on an answer.
 *
 * Deliberately not one of the four statuses. Those carry the human's decision,
 * and this is what happened afterwards: keeping them apart is what lets the
 * next session tell "answered, do it" from "answered, already done", and what
 * lets the person who answered see that their answer landed somewhere.
 *
 * Only an answered question can be acknowledged. Acting on a question nobody
 * has answered is not an acknowledgement, it is a guess.
 */
export async function acknowledgeEscalation(
  store: Store,
  project: ProjectDoc,
  id: string,
  input: { agent: string; note?: string },
): Promise<EscalationDoc> {
  const now = new Date();
  const updated = await store.escalations.findOneAndUpdate(
    { _id: id, projectId: project._id, status: { $ne: 'open' }, acknowledgedAt: null },
    {
      $set: {
        acknowledgedAt: now,
        acknowledgedBy: input.agent.slice(0, 48),
        acknowledgedNote: (input.note ?? '').slice(0, 2000) || null,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    const existing = await store.escalations.findOne({ _id: id, projectId: project._id });
    if (!existing) throw new ServiceError(404, 'not_found', 'No such question in this project.');
    if (existing.status === 'open') {
      throw new ServiceError(
        409,
        'not_answered',
        'That question has no answer yet. Acting on it now would be a guess, not an acknowledgement.',
      );
    }
    throw new ServiceError(
      409,
      'already_acknowledged',
      `${existing.acknowledgedBy} already acted on this one. Read the note before doing it twice.`,
    );
  }

  if (updated.itemSlug) {
    await appendNote(
      store,
      project,
      updated.itemSlug,
      input.agent,
      input.note
        ? `acted on the operator's answer: ${input.note.slice(0, 160)}`
        : "acted on the operator's answer",
    ).catch(() => undefined);
  }
  return updated as EscalationDoc;
}

export async function createEscalation(
  store: Store,
  project: ProjectDoc,
  input: {
    agent: string;
    question: string;
    context?: string;
    priority?: EscalationPriority;
    itemSlug?: string | null;
  },
): Promise<EscalationDoc> {
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    throw badRequest('bad_question', 'An escalation needs a question the operator can answer.');
  }
  if (input.priority !== undefined && !ESCALATION_PRIORITIES.includes(input.priority)) {
    throw badRequest('bad_priority', `Priority is one of ${ESCALATION_PRIORITIES.join(', ')}.`);
  }
  // Like the item cap, this limits the queue rather than the history: a project
  // that has answered five hundred questions is not full, it is well run. And
  // like the item cap, the counter moves after the write, so a crash mid-write
  // hands out one extra slot rather than permanently withholding one.
  if (project.counts.escalations >= project.limits.escalations) {
    throw limitReached('unanswered escalations', project.limits.escalations);
  }

  const now = new Date();
  const doc: EscalationDoc = {
    _id: newId('e'),
    projectId: project._id,
    agent: input.agent,
    question: input.question.slice(0, 2000),
    context: (input.context ?? '').slice(0, 8000),
    priority: input.priority ?? 'normal',
    priorityRank: PRIORITY_RANK[input.priority ?? 'normal'],
    status: 'open',
    answer: null,
    answeredAt: null,
    itemSlug: input.itemSlug ? normalizeSlug(input.itemSlug) : null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgedNote: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.escalations.insertOne({ ...doc, expiresAt: project.expiresAt });
  await store.projects.updateOne({ _id: project._id }, { $inc: { 'counts.escalations': 1 } });

  if (doc.itemSlug) {
    await store.items.updateOne(
      { projectId: project._id, slug: doc.itemSlug },
      {
        $push: {
          timeline: {
            $each: [
              {
                at: now,
                by: input.agent,
                kind: 'escalated' as const,
                message: `asked the operator: ${doc.question.slice(0, 160)}`,
              },
            ],
            $slice: -TIMELINE_KEEP,
          },
        },
        $inc: { timelineCount: 1 },
        $set: { updatedAt: now },
      },
    );
  }
  return doc;
}

export async function listEscalations(
  store: Store,
  projectId: string,
  filter: {
    status?: EscalationStatus;
    agent?: string;
    limit?: number;
    /**
     * Cursor from a previous page: `<iso timestamp>|<id>`. The id is part of it
     * because several questions can be filed in the same millisecond, and a
     * cursor on the timestamp alone silently skips every one of them but the
     * first.
     */
    cursor?: string;
    acknowledged?: boolean;
  } = {},
): Promise<EscalationDoc[]> {
  const query: Record<string, unknown> = { projectId };
  if (filter.status) query.status = filter.status;
  if (filter.agent) query.agent = filter.agent;
  // Whether anybody acted on it, which is a different question from what the
  // human decided. A job asking "what is new for me" is asking this one.
  if (filter.acknowledged === true) query.acknowledgedAt = { $ne: null };
  if (filter.acknowledged === false) query.acknowledgedAt = null;

  if (filter.cursor) {
    const separator = filter.cursor.lastIndexOf('|');
    const at = new Date(separator === -1 ? filter.cursor : filter.cursor.slice(0, separator));
    const id = separator === -1 ? null : filter.cursor.slice(separator + 1);
    if (Number.isNaN(at.getTime())) {
      throw new ServiceError(400, 'bad_cursor', 'A cursor is "<iso timestamp>|<id>".');
    }
    query.$or = id
      ? [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: id } }]
      : [{ createdAt: { $lt: at } }];
  }

  return store.escalations
    .find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    .toArray() as Promise<EscalationDoc[]>;
}

export function escalationCursor(doc: EscalationDoc): string {
  return `${doc.createdAt.toISOString()}|${doc._id}`;
}

export async function answerEscalation(
  store: Store,
  projectId: string,
  id: string,
  status: EscalationStatus,
  answer: string,
): Promise<EscalationDoc> {
  const now = new Date();
  const before = await store.escalations.findOne({ projectId, _id: id });
  if (!before) throw new ServiceError(404, 'not_found', `No escalation ${id} in this project.`);

  const wasOpen = before.status === 'open';
  const isOpen = status === 'open';

  // Reopening puts a question back in the queue, so it is refused at the cap
  // like a new one. Without this, answering and reopening in a loop walks past
  // the limit.
  if (!wasOpen && isOpen) {
    const project = await store.projects.findOne(
      { _id: projectId },
      { projection: { limits: 1, counts: 1 } },
    );
    if (project && project.counts.escalations >= project.limits.escalations) {
      throw limitReached('unanswered escalations', project.limits.escalations);
    }
  }

  // The previous status is the guard, so two operators answering the same
  // question at once produce one transition and one accounting entry.
  // A new decision clears whatever an agent did about the old one: leaving it
  // set would keep the question out of that agent's inbox and refuse its
  // acknowledgement, so the second decision would reach nobody. The same
  // decision sent twice is not a new one, though, and a client retrying after
  // a timeout must not put finished work back in somebody's queue.
  const changed = before.status !== status || before.answer !== answer;
  const doc = await store.escalations.findOneAndUpdate(
    { projectId, _id: id, status: before.status },
    {
      $set: {
        status,
        answer,
        answeredAt: now,
        updatedAt: now,
        ...(changed
          ? { acknowledgedAt: null, acknowledgedBy: null, acknowledgedNote: null }
          : {}),
      },
    },
    { returnDocument: 'after' },
  );

  if (!doc) {
    const current = await store.escalations.findOne({ projectId, _id: id });
    if (!current) throw new ServiceError(404, 'not_found', `No escalation ${id} in this project.`);
    return current as EscalationDoc;
  }

  if (wasOpen !== isOpen) {
    await store.projects.updateOne(
      { _id: projectId },
      { $inc: { 'counts.escalations': isOpen ? 1 : -1 } },
    );
  }
  return doc as EscalationDoc;
}

// --------------------------------------------------------------- api keys

export async function createApiKey(
  store: Store,
  project: ProjectDoc,
  input: { name?: string; role?: 'write' | 'admin' },
): Promise<{ key: ApiKeyDoc; token: string }> {
  const token = newToken();
  const now = new Date();
  const key: ApiKeyDoc = {
    _id: newId('k'),
    projectId: project._id,
    hash: hashToken(token),
    name: (input.name ?? 'unnamed').slice(0, 80),
    role: input.role ?? 'write',
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  await store.keys.insertOne({ ...key, expiresAt: project.expiresAt });
  return { key, token };
}

export async function listApiKeys(store: Store, projectId: string): Promise<ApiKeyDoc[]> {
  return store.keys
    .find({ projectId }, { projection: { hash: 0 } })
    .sort({ createdAt: 1 })
    .toArray() as Promise<ApiKeyDoc[]>;
}

export async function revokeApiKey(
  store: Store,
  projectId: string,
  keyId: string,
): Promise<void> {
  const result = await store.keys.updateOne(
    { projectId, _id: keyId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (result.matchedCount === 0) {
    throw new ServiceError(404, 'not_found', `No active key ${keyId} in this project.`);
  }
}
