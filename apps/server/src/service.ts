import type { Config } from './config.js';
import type { Store } from './db.js';
import { resolveAbsent } from './hygiene.js';
import { hashToken, isValidHandle, newId, newToken, normalizeHandle, normalizeSlug } from './ids.js';
import {
  DEFAULT_RULES,
  ESCALATION_PRIORITIES,
  ITEM_STATUSES,
  TERMINAL_STATUSES,
  type AgentDoc,
  type ApiKeyDoc,
  type EscalationDoc,
  type EscalationPriority,
  type EscalationStatus,
  type ItemDoc,
  type ItemStatus,
  type ProjectDoc,
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
    `This project is capped at ${limit} ${what}. Close or delete some, or claim the project to raise the cap.`,
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

/** Words only, for the soft duplicate check. Not an identity, just a hint. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2)
    .sort()
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
  input: { name?: string },
): Promise<CreatedProject> {
  const now = new Date();
  const id = newId('p');
  const project: ProjectDoc = {
    _id: id,
    name: (input.name ?? 'Untitled project').slice(0, 120),
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
  // Best effort, and deliberately not awaited on the request path.
  void store.keys.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } });
  return { project, key };
}

export async function claimProjectWithEmail(
  store: Store,
  project: ProjectDoc,
  email: string,
  config: Config,
): Promise<void> {
  const now = new Date();
  await store.projects.updateOne(
    { _id: project._id },
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

export async function touchAgent(store: Store, projectId: string, handle: string): Promise<void> {
  if (!handle) return;
  void store.agents.updateOne(
    { projectId, handle },
    { $set: { lastSeenAt: new Date() } },
  );
}

/**
 * Advisory scope matching. A scope token matches an item when it is a prefix of
 * the slug, one of its labels, or its owner. Nothing here blocks a write: the
 * the board this replaced incident that motivated it was solved socially, by making the boundary
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

  const existing = await store.items.findOne(
    { projectId: project._id, slug },
    { projection: { _id: 1, status: 1, title: 1 } },
  );

  // The cap counts open items, not slugs ever written, so a project that has
  // closed a thousand tickets is not bricked. The slot is taken atomically:
  // reading the count and then inserting lets a burst of agents walk straight
  // past the limit together.
  const willBeTerminal = input.status !== undefined && TERMINAL_STATUSES.includes(input.status);
  let reserved = false;
  if (!existing) {
    if (!willBeTerminal) {
      const slot = await store.projects.findOneAndUpdate(
        { _id: project._id, 'counts.items': { $lt: project.limits.items } },
        { $inc: { 'counts.items': 1 } },
        { projection: { _id: 1 } },
      );
      if (!slot) throw limitReached('open items', project.limits.items);
      reserved = true;
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

  const status = input.status;
  if (status !== undefined) {
    set.status = status;
    set.closedAt = TERMINAL_STATUSES.includes(status) ? now : null;
  } else {
    setOnInsert.status = 'open';
    setOnInsert.closedAt = null;
  }

  const entries: TimelineEntry[] = [];
  if (!existing) {
    entries.push({ at: now, by: input.actor, kind: 'created', message: input.note ?? 'created' });
  } else {
    if (status !== undefined && status !== existing.status) {
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
      { upsert: true, returnDocument: 'after', includeResultMetadata: true },
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

  const created = !result.lastErrorObject?.updatedExisting;
  const item = result.value as ItemDoc;
  const isTerminal = TERMINAL_STATUSES.includes(item.status);

  // Keep the open-item count honest across every path a write can take. The
  // periodic sweep recomputes it from the collection anyway, so a lost race
  // costs a minute of drift rather than a wrong limit forever.
  let delta = 0;
  if (created) {
    if (reserved && isTerminal) delta -= 1;
    if (!reserved && !isTerminal) delta += 1;
  } else {
    if (reserved) {
      // Another writer inserted the same slug between our check and our write.
      delta -= 1;
    } else if (existing) {
      const wasTerminal = TERMINAL_STATUSES.includes(existing.status);
      if (wasTerminal && !isTerminal) delta += 1;
      if (!wasTerminal && isTerminal) delta -= 1;
    }
  }
  if (delta !== 0) {
    await store.projects.updateOne({ _id: project._id }, { $inc: { 'counts.items': delta } });
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
      $set: { updatedAt: now, touchedAt: now, stale: false, staleSince: null },
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
      $set: { claim: null, updatedAt: now, touchedAt: now },
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

export interface ListItemsQuery {
  status?: ItemStatus;
  owner?: string;
  label?: string;
  source?: string;
  stale?: boolean;
  claimed?: boolean;
  limit?: number;
  includeTimeline?: boolean;
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

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const projection = query.includeTimeline ? undefined : { timeline: 0 };
  return store.items
    .find(filter, projection ? { projection } : {})
    .sort({ priority: -1, updatedAt: -1 })
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
 * neighbour's ticket. That is the whole fix for the scope drift that cost the
 * board this replaced two strikes and an operator escalation.
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
 * generic form of the audit-sync it replaced, and the reason the absence rule can be a
 * rule instead of a bespoke service.
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
  if (project.counts.escalations >= project.limits.escalations) {
    throw limitReached('escalations', project.limits.escalations);
  }
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    throw badRequest('bad_question', 'An escalation needs a question the operator can answer.');
  }
  if (input.priority !== undefined && !ESCALATION_PRIORITIES.includes(input.priority)) {
    throw badRequest('bad_priority', `Priority is one of ${ESCALATION_PRIORITIES.join(', ')}.`);
  }
  const now = new Date();
  const doc: EscalationDoc = {
    _id: newId('e'),
    projectId: project._id,
    agent: input.agent,
    question: input.question.slice(0, 2000),
    context: (input.context ?? '').slice(0, 8000),
    priority: input.priority ?? 'normal',
    status: 'open',
    answer: null,
    answeredAt: null,
    itemSlug: input.itemSlug ? normalizeSlug(input.itemSlug) : null,
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
  filter: { status?: EscalationStatus; agent?: string; limit?: number } = {},
): Promise<EscalationDoc[]> {
  const query: Record<string, unknown> = { projectId };
  if (filter.status) query.status = filter.status;
  if (filter.agent) query.agent = filter.agent;
  return store.escalations
    .find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    .toArray() as Promise<EscalationDoc[]>;
}

export async function answerEscalation(
  store: Store,
  projectId: string,
  id: string,
  status: EscalationStatus,
  answer: string,
): Promise<EscalationDoc> {
  const now = new Date();
  const doc = await store.escalations.findOneAndUpdate(
    { projectId, _id: id },
    { $set: { status, answer, answeredAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!doc) throw new ServiceError(404, 'not_found', `No escalation ${id} in this project.`);
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
