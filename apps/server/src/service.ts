import type { Config } from './config.js';
import type { Store } from './db.js';
import { record, type EventDoor } from './events.js';
import { charge, maybeExpireClaims, maybeSweep, resolveAbsent, spend } from './hygiene.js';
import { hashToken, isValidHandle, newId, newOtpCode, newToken, normalizeHandle, normalizeSlug } from './ids.js';
import {
  DEFAULT_RULES,
  ESCALATION_PRIORITIES,
  ITEM_STATUSES,
  PRIORITY_RANK,
  TERMINAL_STATUSES,
  type ItemSuccessor,
  type AgentDoc,
  type ApiKeyDoc,
  type EscalationDoc,
  type EscalationPriority,
  type EscalationStatus,
  type HandoverRequestDoc,
  type ItemDoc,
  type ItemStatus,
  type ProjectDoc,
  type ProjectVisibility,
  type ShareDoc,
  type TimelineEntry,
  type TimelineKind,
  OPERATOR_ACTOR,
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

/**
 * How many cards one card may say it waits on.
 *
 * A ceiling rather than a rule about work: the list is read on the claim path
 * and printed in a refusal, and neither is worth doing for a hundred names. A
 * card with more prerequisites than this is a plan, and a plan belongs in the
 * body where a person can read it.
 */
export const MAX_BLOCKERS = 20;

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
  // Two fields, both strings, and nothing else. What arrives here is spread
  // into the filter of the write itself, after `projectId` and `slug`: an
  // `expect` carrying `{"projectId": {"$ne": null}}` would otherwise overwrite
  // the scoping and reach another project's card. The HTTP door refuses the
  // extra keys by schema and MCP arguments are whatever a model produced, so
  // the guard is rebuilt here, where both doors pass through.
  let then: UpsertItemInput['then'];
  if (input.then !== undefined && input.then !== null) {
    const raw = input.then as unknown as Record<string, unknown>;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw badRequest('bad_then', 'then is the card to file when this one is done.');
    }
    const next = normalizeSlug(typeof raw.slug === 'string' ? raw.slug : '');
    if (!next) {
      throw badRequest('bad_then', 'then needs the slug of the card to file.');
    }
    if (next === normalizeSlug(input.slug)) {
      throw badRequest(
        'bad_then',
        'A card cannot file itself when it finishes: that is a loop with one step in it.',
      );
    }
    then = {
      slug: next,
      ...(typeof raw.title === 'string' ? { title: raw.title.slice(0, 300) } : {}),
      ...(typeof raw.body === 'string' ? { body: raw.body.slice(0, 20_000) } : {}),
      ...(typeof raw.priority === 'number' ? { priority: raw.priority } : {}),
      ...(Array.isArray(raw.labels) && raw.labels.every((label) => typeof label === 'string')
        ? { labels: raw.labels as string[] }
        : {}),
      ...(typeof raw.owner === 'string' || raw.owner === null ? { owner: raw.owner as string | null } : {}),
    };
    if (then.priority !== undefined && (!Number.isInteger(then.priority) || then.priority < -10 || then.priority > 10)) {
      throw badRequest('bad_then', 'then.priority is an integer between -10 and 10.');
    }
  }

  let blockedBy: string[] | undefined;
  if (input.blockedBy !== undefined) {
    if (!Array.isArray(input.blockedBy) || input.blockedBy.some((s) => typeof s !== 'string')) {
      throw new ServiceError(
        400,
        'bad_blocked_by',
        'blocked_by is an array of slugs this card waits on.',
        { reason: 'not_a_list' },
      );
    }
    if (input.blockedBy.length > MAX_BLOCKERS) {
      throw new ServiceError(
        400,
        'bad_blocked_by',
        `A card waits on at most ${MAX_BLOCKERS} others. More than that is a plan, and a plan belongs in the body.`,
        { reason: 'too_many' },
      );
    }
    const own = normalizeSlug(input.slug);
    const seen = new Set<string>();
    for (const raw of input.blockedBy) {
      const slug = normalizeSlug(raw);
      if (!slug) {
        // Refused rather than skipped. Dropping it stored a card that waits on
        // nothing, which then claims cleanly: the one outcome this field
        // exists to prevent, arrived at by a typo nobody was told about.
        //
        // The three ways this field is refused share a code, because an agent
        // acts on the code, and carry a `reason` beside it, because the page a
        // person typed into has to say which of the three happened.
        throw new ServiceError(
          400,
          'bad_blocked_by',
          `"${String(raw).slice(0, 40)}" is not a slug, so nothing can be waiting on it.`,
          { reason: 'not_a_slug' },
        );
      }
      if (slug === own) {
        throw new ServiceError(400, 'bad_blocked_by', 'A card cannot wait on itself.', {
          reason: 'itself',
        });
      }
      seen.add(slug);
    }
    blockedBy = [...seen];
  }

  let expect: UpsertItemInput['expect'];
  if (input.expect !== undefined) {
    if (typeof input.expect !== 'object' || input.expect === null || Array.isArray(input.expect)) {
      throw badRequest('bad_expect', 'expect is an object of the title and body you last saw.');
    }
    const known = ['title', 'body'] as const;
    for (const key of Object.keys(input.expect)) {
      if (!known.includes(key as (typeof known)[number])) {
        throw badRequest(
          'bad_expect',
          `expect takes ${known.join(' and ')}, and "${key}" is neither. It is what you last saw, not a query.`,
        );
      }
    }
    expect = {};
    for (const key of known) {
      const value = input.expect[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        throw badRequest('bad_expect', `expect.${key} is the string you last saw.`);
      }
      expect[key] = value;
    }
    if (Object.keys(expect).length === 0) {
      throw badRequest('bad_expect', 'expect said nothing to check. Send the title or the body you last saw.');
    }
  }
  return {
    ...input,
    then: input.then === null ? null : then,
    blockedBy,
    expect,
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
  door: EventDoor,
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
    sweptAt: null,
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

  // Counted here rather than at the four routes that create projects, because
  // three of them counted and the browser form did not. It is the denominator
  // of the activation and claim rates, so a door missing from it does not read
  // as a gap: it reads as a rate above a hundred percent, or as a landing page
  // that converts nobody.
  record(store, 'signup', { door, projectId: project._id });
  return { project, adminToken };
}

export interface AuthContext {
  project: ProjectDoc;
  key: ApiKeyDoc;
}

export async function authenticate(store: Store, token: string): Promise<AuthContext> {
  const key = await store.keys.findOne({
    hash: hashToken(token),
    revokedAt: null,
    // A key can carry an expiry: the project's, for a demo, or an hour, for one
    // minted through the OAuth token endpoint. The TTL index deletes the
    // document eventually, but "eventually" is up to a minute of a dead token
    // still opening the door, and the door is what this function is.
    $or: [
      { expiresAt: null },
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: new Date() } },
    ],
  });
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
 * The one shape test for an address, so a door that has to refuse before it
 * writes anything asks the same question the write would have asked.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.trim().toLowerCase());
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
  if (!looksLikeEmail(email)) {
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
        notifiedAt: null,
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
    // Filled in by the notifier if the message lands, and only then. Never
    // cleared afterwards: it records that this address has been told about
    // this board, which is the fact the inbox needs, and not which attempt
    // did the telling. Clearing it on a repeat made the two questions one and
    // put a race between overlapping sends in the middle of it.
    notifiedAt: null,
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
  // Answering somebody's request closes it. Leaving it open would keep telling
  // the agents to do the thing they just did.
  await store.handovers.deleteOne({ projectId: project._id, email }).catch(() => undefined);
  return { share: (result ?? share) as ShareDoc, alreadyOwned: false };
}

/** How many people can have an outstanding request on one project. */
const MAX_HANDOVER_REQUESTS = 5;

/**
 * A person with the read link asking the agents to hand the board over.
 *
 * The other half of `shareProject`, and the asymmetry is the point. A share
 * moves ownership because the project offered it; this only records that
 * somebody would like it, and the project still has to answer with a share.
 * Ownership is a door that opens one way: nothing here ever sets `claimedBy`
 * back to null, and an owner can mint an admin key at will, so a read link
 * that could take a project would turn a forwarded URL into a permanent loss.
 * A read link that can ask costs nothing and unblocks the person who actually
 * has the link.
 */
export async function requestHandover(
  store: Store,
  project: ProjectDoc,
  email: string,
  note?: string,
): Promise<HandoverRequestDoc> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(address)) {
    throw badRequest('bad_email', 'That does not look like an email address.');
  }
  if (project.claimedBy) {
    throw new ServiceError(
      409,
      'already_owned',
      project.claimedBy === address
        ? 'You already own this project.'
        : 'Somebody already owns this project. Ask them to hand it over.',
    );
  }
  const now = new Date();
  const outstanding = await store.handovers.countDocuments({ projectId: project._id });
  if (outstanding >= MAX_HANDOVER_REQUESTS) {
    // A queue of requests on one unclaimed project is not a queue, it is a
    // list of people who will not get it.
    const existing = await store.handovers.findOne({ projectId: project._id, email: address });
    if (!existing) {
      throw new ServiceError(
        409,
        'too_many_requests',
        'Several people are already waiting on this project. The agents have to answer one of them first.',
      );
    }
  }

  const request: HandoverRequestDoc = {
    _id: newId('h'),
    projectId: project._id,
    email: address,
    note: (note ?? '').slice(0, 500),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 14 * 86_400_000),
  };
  // Asking twice is the same ask: the note is refreshed, the moment of asking
  // belongs to the first one.
  const result = await store.handovers.findOneAndUpdate(
    { projectId: project._id, email: address },
    {
      $set: { note: request.note, expiresAt: request.expiresAt },
      $setOnInsert: {
        _id: request._id,
        projectId: request.projectId,
        email: request.email,
        createdAt: request.createdAt,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return (result ?? request) as HandoverRequestDoc;
}

/**
 * What is waiting for an agent, in one place: the answers it has not acted on,
 * its own questions nobody has answered, and anybody asking for the board.
 *
 * One function because there are two doors and they drifted apart within a day
 * of the second one being added. The MCP version filtered a single page of
 * escalations in memory, which quietly dropped an open question off the end
 * once a project had fifty answered ones, and never applied the "already acted
 * on" filter at all, so an agent in a loop kept being handed the same decision
 * to carry out again. Both are the exact confusions the fields exist to end.
 */
export async function readInbox(
  store: Store,
  project: ProjectDoc,
  options: { agent?: string; includeActed?: boolean } = {},
): Promise<{
  answers: EscalationDoc[];
  waiting: EscalationDoc[];
  handovers: HandoverRequestDoc[];
  /**
   * Offers of this board that nobody has accepted yet.
   *
   * A board stays unclaimed from the moment it is offered until the person
   * clicks, which is minutes at best and a night at worst. Reading "unclaimed"
   * as "nobody has been asked" over that window tells an agent to offer it
   * again, and offering it again sends another mail to somebody who has one
   * sitting unread.
   */
  offers: number;
}> {
  // A handle, not a query: this value is spread into the filter below, and an
  // `agent` of `{"$ne": null}` read every agent's inbox instead of refusing.
  if (options.agent !== undefined && typeof options.agent !== 'string') {
    throw badRequest('bad_agent', 'agent is the handle whose inbox this is.');
  }
  const forAgent = options.agent ? { agent: options.agent } : {};
  const [answers, waiting, handovers, offers] = await Promise.all([
    store.escalations
      .find({
        projectId: project._id,
        status: { $ne: 'open' },
        ...(options.includeActed ? {} : { acknowledgedAt: null }),
        ...forAgent,
      })
      .sort({ answeredAt: -1 })
      .limit(50)
      .toArray(),
    // Oldest first: the oldest question is the one that has been holding work
    // up the longest.
    store.escalations
      .find({ projectId: project._id, status: 'open', ...forAgent })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray(),
    project.claimedBy ? Promise.resolve([]) : listHandoverRequests(store, project._id),
    // Only asked about on a board that has no owner, because that is the only
    // board where the difference between "offered" and "nobody has been asked"
    // decides what an agent should do next. An offer expires on its own, so
    // this counts the live ones the way everything else here does.
    project.claimedBy
      ? Promise.resolve(0)
      : store.shares.countDocuments({
          projectId: project._id,
          expiresAt: { $gt: new Date() },
          // Sent, not merely stored. An offer the provider discarded, or one
          // written on a deployment that cannot send at all, is an offer
          // nobody has seen, and telling the agents to stop offering it would
          // leave the person it was meant for waiting on a message that does
          // not exist.
          notifiedAt: { $ne: null },
        }),
  ]);
  return {
    answers: answers as EscalationDoc[],
    waiting: waiting as EscalationDoc[],
    handovers,
    offers,
  };
}

/** Who has asked for this project, oldest first. */
export async function listHandoverRequests(
  store: Store,
  projectId: string,
): Promise<HandoverRequestDoc[]> {
  return store.handovers.find({ projectId }).sort({ createdAt: 1 }).limit(10).toArray();
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

/** How many wrong codes a pending claim survives. */
export const MAX_CLAIM_ATTEMPTS = 5;

/** How long an emailed claim code is good for. */
export const CLAIM_CODE_TTL_MS = 15 * 60_000;

/**
 * Start the human claim: mint a code and mail it.
 *
 * Shared, like `verifyClaimCode`, and for a sharper reason. The browser form
 * used to reach this by making an HTTP request to our own public base URL,
 * which is a request that leaves the process, comes back through the router,
 * and cannot be exercised by a test at all: the suite's base URL does not
 * resolve, so the route answered 500 and the test that was supposed to prove a
 * read link cannot take a project passed without ever reaching the check it
 * was about.
 *
 * The caller decides who is allowed to ask. This function only refuses what is
 * wrong with the request itself.
 */
export async function startEmailClaim(
  store: Store,
  project: ProjectDoc,
  email: string,
  config: Config,
  mailer: { sendClaimCode(to: string, code: string, projectName: string): Promise<string> },
): Promise<{ alreadyClaimedBy: string | null; delivery: string; expiresInSeconds: number }> {
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw badRequest('bad_email', 'That does not look like an email address.');
  }
  if (project.claimedBy) {
    return { alreadyClaimedBy: project.claimedBy, delivery: 'none', expiresInSeconds: 0 };
  }

  const code = newOtpCode();
  const now = new Date();
  const address = email.toLowerCase();
  await store.claimCodes.deleteMany({ projectId: project._id });
  await store.claimCodes.insertOne({
    _id: newId('c'),
    projectId: project._id,
    email: address,
    codeHash: hashToken(code),
    attempts: 0,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLAIM_CODE_TTL_MS),
  });
  const delivery = await mailer.sendClaimCode(email, code, project.name);
  if (delivery === 'discarded') {
    // The code exists and reached nobody. Answering ok here tells an agent to
    // wait for something that is never coming, so the misconfiguration is
    // reported as the fault it is.
    await store.claimCodes.deleteMany({ projectId: project._id, email: address });
    throw new ServiceError(
      503,
      'mail_not_configured',
      'This deployment cannot send email, so the code could not be delivered. Nothing is pending. Tell whoever runs it to set RESEND_API_KEY, or hand the project over with /share instead.',
    );
  }
  return { alreadyClaimedBy: null, delivery, expiresInSeconds: CLAIM_CODE_TTL_MS / 1000 };
}

/**
 * Spend one attempt on a pending claim, and claim the project if it matched.
 *
 * Shared by the API route and the browser form, so that the person who started
 * a claim on the read link can finish it there. The attempt is spent in the
 * write that reads the code, so several guesses arriving together cannot all
 * see the same count and slip past the ceiling between them. Expiry is checked
 * here rather than left to the TTL index, which sweeps on its own schedule and
 * runs late under load, so a fifteen minute code was quietly good for longer
 * than the response promised.
 */
export async function verifyClaimCode(
  store: Store,
  project: ProjectDoc,
  email: string,
  code: string,
  config: Config,
): Promise<void> {
  const address = email.trim().toLowerCase();
  const pending = await store.claimCodes.findOneAndUpdate(
    {
      projectId: project._id,
      email: address,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: MAX_CLAIM_ATTEMPTS },
    },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!pending) {
    throw new ServiceError(
      404,
      'no_pending_claim',
      'No claim is pending for that address, or it expired or ran out of attempts. Start the claim again.',
    );
  }
  if (pending.codeHash !== hashToken(code)) {
    throw badRequest('bad_code', 'That code does not match.');
  }
  await claimProjectWithEmail(store, project, address, config);
  await store.claimCodes.deleteMany({ projectId: project._id });
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
    // A project with an owner cannot be handed to anybody else, so every
    // request for it is answered, whichever way it went.
    store.handovers.deleteMany({ projectId: project._id }),
    // Including the OAuth client, which is easy to forget precisely because it
    // is not a key: an agent that came in through RFC 7591 registration would
    // otherwise lose its client_id a week after a person made the project
    // permanent, and the failure would read as "invalid_client" on a board
    // that is not going anywhere.
    store.oauthClients.updateMany({ projectId: project._id }, clear),
    // Every key except the ones that expire for a reason of their own. An
    // access token from the OAuth endpoint carries an hour, and clearing that
    // here because the project stopped expiring would silently promote it to a
    // permanent admin credential.
    store.keys.updateMany({ projectId: project._id, ownExpiry: { $ne: true } }, clear),
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
  if (handle === OPERATOR_ACTOR) {
    throw badRequest(
      'reserved_handle',
      `"${OPERATOR_ACTOR}" is the name every write from the board itself carries, so a person and an agent would sign the same way. Pick a handle of your own.`,
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

export interface RenamedAgent {
  from: string;
  to: string;
  items: number;
  claims: number;
  merged: boolean;
}

/**
 * Consolidating a handle that got written two ways.
 *
 * The warnings catch a typo the first time it is used, which does not help a
 * board that collected forty items under `trades_loop` before anybody read one.
 * This is the other half: the state moves, the history does not.
 *
 * State is `lastActor` and a live claim, which answer "whose work is this" and
 * "who is holding it", and both are about now. The timeline is what happened,
 * and what happened is that an agent calling itself `trades_loop` wrote that
 * line. Rewriting it would make the record say something that was never true,
 * so the old name is kept on the agent instead, where a reader who meets it in
 * an old entry can find out who it became.
 */
export async function renameAgent(
  store: Store,
  project: ProjectDoc,
  fromRaw: string,
  toRaw: string,
): Promise<RenamedAgent> {
  const from = normalizeHandle(fromRaw ?? '');
  const to = normalizeHandle(toRaw ?? '');
  if (!isValidHandle(from) || !isValidHandle(to)) {
    throw badRequest(
      'bad_handle',
      'A handle is lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.',
    );
  }
  if (from === to) {
    throw badRequest('same_handle', 'That is the name it already writes under.');
  }
  if (from === OPERATOR_ACTOR || to === OPERATOR_ACTOR) {
    throw badRequest(
      'reserved_handle',
      `"${OPERATOR_ACTOR}" is what a person's own writes are signed with, not an agent that spelled itself wrong. Consolidating it either way would put one of them under the other's name.`,
    );
  }

  const [leaving, arriving] = await Promise.all([
    store.agents.findOne({ projectId: project._id, handle: from }),
    store.agents.findOne({ projectId: project._id, handle: to }),
  ]);
  const wroteHere = await store.items.countDocuments({ projectId: project._id, lastActor: from });
  if (!leaving && wroteHere === 0) {
    throw notFound(from);
  }

  const now = new Date();
  const [items, claims] = await Promise.all([
    store.items.updateMany(
      { projectId: project._id, lastActor: from },
      { $set: { lastActor: to } },
    ),
    store.items.updateMany(
      { projectId: project._id, 'claim.agent': from },
      { $set: { 'claim.agent': to } },
    ),
  ]);

  // The registration follows the work. Two registrations become one, because a
  // board that offers both names in its filter has not been consolidated, it
  // has been given a second row.
  const aliases = [
    ...new Set([...(arriving?.aliases ?? []), ...(leaving?.aliases ?? []), from]),
  ].slice(0, 32);
  if (arriving) {
    await store.agents.updateOne(
      { _id: arriving._id },
      { $set: { aliases, lastSeenAt: now } },
    );
    if (leaving) {
      await store.agents.deleteOne({ _id: leaving._id });
      // Two registrations became one, so the count of them has to say one. A
      // plain decrement, floored, because the agent counter has no repair pass
      // behind it the way items and questions do.
      await store.projects.updateOne(
        { _id: project._id, 'counts.agents': { $gt: 0 } },
        { $inc: { 'counts.agents': -1 } },
      );
    }
  } else if (leaving) {
    await store.agents.updateOne(
      { _id: leaving._id },
      { $set: { handle: to, aliases, lastSeenAt: now } },
    );
  } else if (project.counts.agents < project.limits.agents) {
    // Neither name was ever registered, which is the case this exists for:
    // work filed under two spellings nobody declared. The surviving one gets
    // the registration, because a consolidated handle that is still only a
    // string on an item is a handle the next writer can misspell again, and
    // because the alias has to live somewhere for an old timeline entry to be
    // readable at all.
    //
    // Under the same cap and the same expiry as any other registration: a plan
    // is a plan whichever door adds the row, and an agent with no `expiresAt`
    // on a demo project outlives the project it belongs to, because the TTL
    // index passes over documents that do not carry the field.
    await store.agents.insertOne({
      _id: newId('a'),
      projectId: project._id,
      handle: to,
      scope: [],
      description: '',
      registeredAt: now,
      lastSeenAt: now,
      aliases,
      meta: {},
      expiresAt: project.expiresAt,
    } as never);
    await store.projects.updateOne({ _id: project._id }, { $inc: { 'counts.agents': 1 } });
  }
  // At the cap and neither name registered: the work still moves onto one
  // handle, which is what was asked for. What it does not get is a row nobody
  // has room for, and the alias goes with it: the timeline still says what it
  // said, and there is nowhere to write down what the old name became.


  return {
    from,
    to,
    items: items.modifiedCount,
    claims: claims.modifiedCount,
    merged: Boolean(arriving && leaving),
  };
}

/**
 * Everything this write is worth telling its author, in one place.
 *
 * The name and the scope are the same kind of remark: the write went through,
 * and something about who made it will cost somebody time later. They were
 * composed in the HTTP route, which meant an agent working over MCP was told
 * neither, on a service whose whole point is that both doors are the same door.
 */
export async function writeWarnings(
  store: Store,
  project: Pick<ProjectDoc, '_id' | 'rules'>,
  actor: string,
  item?: Pick<ItemDoc, 'slug' | 'labels' | 'owner'>,
): Promise<string[]> {
  if (!project.rules.scopeWarnings) return [];
  // Before the lookup: on a board where `operator` was registered as an agent
  // before that name was reserved, finding the registration would answer the
  // question with silence, and the ambiguity is the whole point of saying
  // anything.
  if (normalizeHandle(actor) === OPERATOR_ACTOR) {
    const reserved = await nameWarning(store, project._id, actor);
    return reserved ? [reserved] : [];
  }
  const agent = actor ? await store.agents.findOne({ projectId: project._id, handle: actor }) : null;
  if (!agent) {
    const named = await nameWarning(store, project._id, actor);
    return named ? [named] : [];
  }
  if (item && agent.scope.length > 0 && !itemInScope(agent.scope, item)) {
    return [
      `"${item.slug}" is outside your declared scope (${agent.scope.join(', ')}). The write went through; this is a boundary reminder, not a block.`,
    ];
  }
  return [];
}

/**
 * What is wrong with the name on this write, if anything.
 *
 * A handle is free text on purpose: an agent writes before it registers, and
 * refusing a write over bookkeeping loses the write. The cost of that is a
 * board where `trades-loop`, `trades_loop` and `tradesloop` are three agents,
 * `/next` offers none of them work by scope, and a person filtering by any one
 * of them sees a third of the work.
 *
 * So every door that takes an actor says so, once, in words that name the fix.
 * A near miss of a handle that is registered gets named: a typo is far more
 * likely than a fourth loop nobody mentioned, and "did you mean" is the only
 * part of this a machine can answer.
 */
export async function nameWarning(
  store: Store,
  projectId: string,
  actor: string,
): Promise<string | null> {
  // Normalised, because the actor on an item is free text: `Operator` and
  // ` operator ` are the same name to everything that acts on it, and telling
  // only the lowercase one to register is advice the other half never hears.
  if (normalizeHandle(actor) === OPERATOR_ACTOR) {
    return `"${OPERATOR_ACTOR}" is the name this board signs a person's own writes with, so a timeline cannot tell you apart from whoever is reading it. Register a handle of your own and write under that.`;
  }
  // An empty actor and the sentinel it becomes are the same event: nobody
  // said who was writing. Reading them differently is how one of the two ends
  // up silent, which is the case this whole function exists for.
  if (actor === '' || actor === 'unknown-agent') {
    return 'Nothing named itself on that write, so the board shows it as "unknown-agent". Send `actor` with every write, and register the handle with POST /agents so a person can tell it from the others.';
  }
  const agent = await store.agents.findOne({ projectId, handle: actor });
  if (agent) return null;

  const known = await store.agents
    .find({ projectId }, { projection: { handle: 1 } })
    .limit(200)
    .toArray();
  const flat = (handle: string) => handle.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mine = flat(actor);
  // Nothing but punctuation flattens to nothing, and every string starts with
  // nothing: without this, an actor of "---" is told it probably meant whoever
  // registered first.
  const near =
    mine === ''
      ? undefined
      : known
          .map((entry) => entry.handle)
          .find((handle) => {
            const other = flat(handle);
            return other !== '' && (other === mine || other.startsWith(mine) || mine.startsWith(other));
          });
  return near
    ? `No agent is registered here as "${actor}", but "${near}" is. If that is you, use it: two spellings are two agents on this board, and /next offers work by the registered one.`
    : `No agent is registered here as "${actor}", so the board shows a handle nobody has described and /next has no scope to offer it work by. Register with POST /agents, or check the spelling.`;
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
  /**
   * Write the fields only if this call is the one that creates the item.
   *
   * For a caller that has already decided an existing item is not theirs to
   * rewrite, and that reaching one means it lost a race. An anonymous report is
   * the case: two people filing the same title in the same instant both find
   * nothing, both create, and without this the loser's payload lands on the
   * winner's item as an ordinary update. The note still goes on the timeline,
   * because that part is true either way.
   */
  insertOnly?: boolean;
  /**
   * Write only if these fields still say what the caller last saw.
   *
   * For a form somebody had open while somebody else wrote. The check has to be
   * part of the write and not a look before it: between a read and an update
   * there is room for exactly the change this is trying not to lose. A mismatch
   * is a 409 and nothing is written.
   */
  expect?: { title?: string; body?: string };
  /**
   * The writer is not an agent of this project: an anonymous report through
   * `/feedback`, and nothing else so far.
   *
   * A write is normally proof of life. It clears the stale flag, moves
   * `touchedAt` and puts the writer's name on the item, all of which say
   * "somebody who works here is on this". A passer-by saying the same thing
   * twice is not that, and letting it count meant anybody could keep a report
   * looking fresh and signed by them, for ever, by resending its title. The
   * note still lands on the timeline, which is the part that is true.
   */
  guest?: boolean;
  /**
   * The card to file when this one is finished.
   *
   * A pipeline written on the work itself: the item that reaches a terminal
   * status files the next one and says so in both timelines. Idempotent by
   * construction, because the successor is addressed by slug like everything
   * else here, so finishing an item twice writes the same card twice rather
   * than two cards.
   */
  then?: ItemSuccessor | null;
  /**
   * The cards this one is waiting on, by slug. Send an empty array to clear it.
   *
   * Inert on purpose: see `ItemDoc.blockedBy`. It refuses a claim and it keeps
   * the item out of what `/next` offers; it never writes a status.
   */
  blockedBy?: string[];
}

export interface UpsertItemResult {
  item: ItemDoc;
  created: boolean;
  warnings: string[];
  /** The card this one filed on finishing, when it carried a successor. */
  chained?: ItemDoc | null;
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

  // A guarded write is for correcting words that somebody was looking at. The
  // status has its own guard, decided by who owns the transition, and the two
  // run as separate updates: letting them arrive together would move a card and
  // then refuse the edit, which is the opposite of "nothing was written".
  if (input.expect && input.status !== undefined) {
    throw badRequest(
      'guarded_status',
      'A write guarded on what you last saw cannot also move the status. Send the correction, then the move.',
    );
  }

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
    await store.projects.updateOne(
      { _id: project._id },
      delta > 0 ? charge('items', delta) : spend('items', -delta),
    );
  };
  const atCapacity = (): boolean => project.counts.items >= project.limits.items;

  const wasTerminal = existing ? TERMINAL_STATUSES.includes(existing.status) : false;
  const willBeTerminal = input.status !== undefined && TERMINAL_STATUSES.includes(input.status);
  const changesStatus =
    existing !== null && input.status !== undefined && input.status !== existing.status;

  let ownsTransition = false;
  let applyStatus = input.status !== undefined;
  /** Whose claim closing this item dropped, if it dropped one. */
  let releasedClaim: string | null = null;

  if (!existing) {
    // A guard says "only if it still reads like this", which is a sentence
    // about a card that exists. Reaching here means it does not, and the answer
    // is that rather than whatever the capacity check below would have said to
    // a write that was never going to create anything.
    if (input.mustExist || input.expect) throw notFound(slug);
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
          // Finished work is not work in progress. A claim outliving the item
          // it covers puts a done card in the "in progress" column of every
          // board whose column asks `claimed: true`, and leaves the agent
          // holding a lease on something nobody can do anything with. It
          // expires on its own eventually; eventually is up to an hour of a
          // board saying something false.
          ...(willBeTerminal ? { claim: null } : {}),
        },
      },
      // The document as it was, so the entry below can name whose claim this
      // dropped rather than saying that one was dropped.
      { projection: { claim: 1 } },
    );
    ownsTransition = moved !== null;
    releasedClaim = willBeTerminal ? (moved?.claim?.agent ?? null) : null;

    if (!ownsTransition) {
      // Somebody else moved it first, and their status is the one that stands.
      applyStatus = false;
    } else if (wasTerminal !== willBeTerminal) {
      await addSlots(willBeTerminal ? -1 : 1);
    }
  }

  // `touchedAt` is what staleness is measured from, so a guest write moves
  // `updatedAt` (something changed, and the change feed should say so) without
  // moving it.
  const set: Record<string, unknown> = input.guest
    ? { updatedAt: now }
    : { updatedAt: now, touchedAt: now };
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
    // `$setOnInsert` is what makes insertOnly atomic rather than nearly atomic:
    // the decision is taken by the write itself, so a caller that loses the
    // race writes nothing it was not allowed to write.
    else if (input.insertOnly) setOnInsert[field] = value;
    else set[field] = value;
  };

  assign('title', input.title, '');
  assign('body', input.body, '');
  assign('owner', input.owner, null);
  assign('priority', input.priority, 0);
  assign('labels', input.labels, []);
  assign('fields', input.fields, {});
  assign('source', input.source, null);
  assign('then', input.then, null);
  assign('blockedBy', input.blockedBy, []);

  if (input.title !== undefined) {
    if (input.insertOnly) setOnInsert.titleKey = titleKey(input.title);
    else set.titleKey = titleKey(input.title);
  } else setOnInsert.titleKey = '';

  // Any write by an agent is proof of life: it clears the stale flag that the
  // hygiene engine may have set. Hygiene marks, agents unmark, and neither
  // needs to know about the other.
  //
  // A passer-by is not an agent of this project, though. A second anonymous
  // report of the same title used to unmark a stale item and put its own name
  // on it, so anybody could keep a report looking fresh, signed by them, by
  // sending the same title every few days. The note still lands; the item's
  // own liveness belongs to the people who work on it.
  if (input.guest) {
    // Only on the write that creates the item, so a report carries the name of
    // whoever filed it and nothing later can overwrite that from outside. The
    // liveness fields have to be here as well: a document created without
    // `touchedAt` is a document hygiene can never call stale, which would have
    // made a guest report immortal by omission rather than by design.
    setOnInsert.lastActor = input.actor;
    setOnInsert.touchedAt = now;
    setOnInsert.stale = false;
    setOnInsert.staleSince = null;
  } else {
    set.stale = false;
    set.staleSince = null;
    set.lastActor = input.actor;
  }

  const status = applyStatus ? input.status : undefined;
  if (!existing) {
    // On insert, never on update, and that is the whole of it. This branch was
    // reached because the slug did not exist when we looked, and the write can
    // still land on a document somebody created in between. Through `$set` the
    // status would then be applied to a document we never read: no guard, so
    // nobody owns the transition, and no accounting, because the counter is
    // moved either by the guarded branch above or by the creation below and
    // this is neither. Both directions were reachable. A request that meant to
    // create a done item, landing on an open one, closed it and left the
    // counter high; one that meant to create an open item, landing on a done
    // one, opened it and left the counter low, which nothing ever repairs.
    //
    // Losing the race means the other writer's status stands, which is the rule
    // the guarded branch already follows when it loses.
    setOnInsert.status = status ?? 'open';
    setOnInsert.closedAt = status !== undefined && TERMINAL_STATUSES.includes(status) ? now : null;
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
    entries.push({
      at: now,
      by: input.actor,
      // An insertOnly write may still land on an item somebody else created a
      // millisecond earlier, and a second "created" on one item is a claim the
      // record cannot make. A note is true whichever way the race went.
      kind: input.insertOnly ? 'note' : 'created',
      message: input.note ?? 'created',
    });
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
    if (releasedClaim) {
      entries.push({
        at: now,
        by: input.actor,
        kind: 'released',
        message:
          releasedClaim === input.actor
            ? 'released their own claim on closing this'
            : `released ${releasedClaim}'s claim on closing this`,
      });
    }
  }

  const write = () =>
    store.items.findOneAndUpdate(
      { projectId: project._id, slug, ...(input.expect ?? {}) },
      {
        $set: set,
        $setOnInsert: setOnInsert,
        $push: { timeline: { $each: entries, $slice: -TIMELINE_KEEP } },
        $inc: { timelineCount: entries.length },
      },
      {
        // A guard is a statement about a document that already exists, so it
        // never creates one: without this, a mismatch fell into the upsert
        // path and either raised a duplicate key or filed a second card.
        upsert: input.mustExist !== true && input.expect === undefined,
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
  // returns a document. The item was deleted between the lookup above and here,
  // or a guarded write found the field already saying something else.
  if (!result.value) {
    if (input.expect && (await store.items.findOne({ projectId: project._id, slug }))) {
      // The item is there and the guard did not match, which is the whole
      // reason the guard exists.

      throw new ServiceError(
        409,
        'changed_underneath',
        // Neutral about who is reading it: this refusal used to reach a person
        // with a form open and now reaches a loop that read the item a second
        // ago, and "open it again" is not something a loop does.
        `Somebody wrote to "${slug}" after you read it, so nothing was saved: writing your copy back would have thrown their words away. Read it again and redo the change on what it says now.`,
      );
    }
    throw notFound(slug);
  }

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

  // The successor, filed by the item that finished. After the write and only on
  // the crossing: an item that was already done and is written to again files
  // nothing, or every note on a closed card would file the next one afresh.
  // Only the write that owned the crossing files it. Two requests closing the
  // same open item both start with `wasTerminal === false`, and the one whose
  // guarded transition matched nothing would otherwise read the now-terminal
  // item here and file the successor a second time. A creation owns its own
  // crossing, because only one insert wins.
  const crossed = created ? isTerminal : ownsTransition && isTerminal && !wasTerminal;
  const chained =
    crossed && item.then?.slug ? await fileSuccessor(store, project, item, input.actor) : null;
  if (chained) warnings.push(...chained.warnings);

  return { item, created, warnings, ...(chained ? { chained: chained.item } : {}) };
}

/**
 * File what comes after, and say so on both cards.
 *
 * The pipeline lives on the work rather than in an orchestrator: one write
 * says what to do and what to do next, and the board runs it. Addressed by
 * slug like everything else here, so a card that finishes twice files the same
 * successor twice, which is one card.
 *
 * A failure here is not a failure of the write that finished: the item is
 * closed, the caller is told what happened in a warning, and the successor can
 * be filed by hand. Losing the close because the next card could not be
 * created would be the wrong half to keep.
 */
async function fileSuccessor(
  store: Store,
  project: ProjectDoc,
  finished: ItemDoc,
  actor: string,
): Promise<{ item: ItemDoc | null; warnings: string[] }> {
  const next = finished.then!;
  try {
    // Read again rather than reuse the snapshot this write started with: the
    // finish above freed a slot, and the caller's copy of the counts still
    // says the project is full. Filing the next card into the room the
    // previous one just left is the ordinary case at the cap, not the corner.
    const now = (await store.projects.findOne({ _id: project._id })) ?? project;
    const { item } = await upsertItem(store, now, {
      slug: next.slug,
      ...(next.title === undefined ? {} : { title: next.title }),
      ...(next.body === undefined ? {} : { body: next.body }),
      ...(next.priority === undefined ? {} : { priority: next.priority }),
      ...(next.labels === undefined ? {} : { labels: next.labels }),
      ...(next.owner === undefined ? {} : { owner: next.owner }),
      actor,
      note: `filed by "${finished.slug}", which finished`,
    });
    await appendNote(
      store,
      now,
      finished.slug,
      actor,
      `finished, so "${next.slug}" is filed`,
      'note',
    ).catch(() => undefined);
    return { item, warnings: [] };
  } catch (error) {
    const said = error instanceof ServiceError ? error.message : 'the write did not go through';
    return {
      item: null,
      warnings: [
        `"${finished.slug}" is finished, but the card it files next, "${next.slug}", was not created: ${said}`,
      ],
    };
  }
}

export async function appendNote(
  store: Store,
  project: ProjectDoc,
  slug: string,
  rawActor: string,
  message: string,
  kind: TimelineKind = 'note',
): Promise<ItemDoc> {
  const now = new Date();
  // Here rather than at the door, because there is more than one door and the
  // item write already does it. A blank author is a third spelling of "nobody
  // said": the board would carry an empty name beside `unknown-agent`, and a
  // warning telling somebody the board shows the sentinel would be false.
  const actor = rawActor || 'unknown-agent';
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

/**
 * The write that takes a lease, in one place.
 *
 * Two callers do it: claiming a card by name, and asking for the next one and
 * taking it in the same breath. Written twice they would drift, and the second
 * of them would stop marking an item as touched or stop signing it, which is
 * exactly the class of difference nobody notices until a board reads wrong.
 */
/**
 * Hands back a lease this call took a moment ago and must not keep.
 *
 * Guarded on the exact lease rather than on the holder's name: the same agent
 * can heartbeat or re-claim between the two writes, and a rollback matching
 * only the name would delete a newer, valid lease and leave that request
 * reporting a success it no longer has.
 *
 * The history is not unwound, it is continued. `takingIt` has already written
 * "claimed" and moved `touchedAt`, and popping that entry would erase a real
 * moment and could pop somebody else's. What lands instead is the other half
 * of the story, in the words the reader needs: the lease was taken and given
 * straight back, and why.
 */
export async function handBack(
  store: Store,
  projectId: string,
  slug: string,
  agent: string,
  nonce: string,
  why: string,
): Promise<void> {
  const now = new Date();
  await store.items.updateOne(
    { projectId, slug, 'claim.agent': agent, 'claim.nonce': nonce },
    {
      $set: { claim: null, updatedAt: now },
      $push: {
        timeline: {
          $each: [
            {
              at: now,
              by: agent,
              kind: 'released' as const,
              message: `lease handed straight back: ${why}`,
            },
          ],
          $slice: -TIMELINE_KEEP,
        },
      },
      $inc: { timelineCount: 1 },
    },
  );
}

function takingIt(agent: string, now: Date, ttl: number, expiresAt: Date, nonce: string) {
  return {
    $set: {
      claim: { agent, claimedAt: now, heartbeatAt: now, expiresAt, nonce },
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
  };
}

/**
 * What a card is waiting on that has not finished, as a sentence.
 *
 * One query, on the claim path only, and only for a card that says it waits on
 * something. That is the whole cost of the feature: no counter, no index, no
 * fan-out write when a blocker closes, and so nothing that can drift out of
 * agreement with the board.
 *
 * A named card nobody has filed counts as unmet and says so. Ignoring it would
 * make a typo silently do nothing, and "waiting on a card that is not on this
 * board" is something an agent can fix in one write.
 */
export async function unmetBlockers(
  store: Store,
  projectId: string,
  item: Pick<ItemDoc, 'blockedBy'>,
): Promise<Array<{ slug: string; title: string | null; status: ItemStatus | null }>> {
  const waiting = item.blockedBy ?? [];
  if (waiting.length === 0) return [];
  const rows = (await store.items
    .find(
      { projectId, slug: { $in: waiting } },
      { projection: { slug: 1, title: 1, status: 1 } },
    )
    .toArray()) as Array<Pick<ItemDoc, 'slug' | 'title' | 'status'>>;
  const found = new Map(rows.map((row) => [row.slug, row]));
  return waiting
    .map((slug) => {
      const row = found.get(slug);
      return row
        ? { slug, title: row.title, status: row.status }
        : { slug, title: null, status: null };
    })
    .filter((row) => row.status === null || !TERMINAL_STATUSES.includes(row.status));
}

/** The refusal, in the words the agent has to act on. */
function blockedMessage(
  slug: string,
  unmet: Array<{ slug: string; title: string | null; status: ItemStatus | null }>,
): string {
  const named = unmet
    .map((row) =>
      row.status === null
        ? `${row.slug} (not on this board)`
        : `${row.slug} (${row.status}${row.title ? `: ${row.title}` : ''})`,
    )
    .join(', ');
  return `${slug} is waiting on ${named}. Finish or drop ${
    unmet.length === 1 ? 'it' : 'them'
  }, or take this card off the list with blocked_by if it is not really waiting.`;
}

/**
 * Every card on this board that is waiting on something, and what each is
 * still waiting on.
 *
 * One answer for two readers: the offer, which must not hand out work a claim
 * would refuse, and the board, which must not call a card blocked once its
 * prerequisites are finished. Two queries when a board uses the field at all,
 * nothing at all to maintain when a blocker closes, and nothing that can drift
 * out of agreement with either.
 *
 * Not restricted to open cards. A card somebody parked as `blocked` still
 * refuses a claim for its unmet dependency, so a board drawn from an
 * offer-only set would take the chip off exactly the cards a person is looking
 * for. Terminal statuses are left out because a finished card is not waiting
 * for anything.
 */
export async function waitingBlockers(
  store: Store,
  projectId: string,
  /**
   * Which cards to ask about. The board asks about everything that is not
   * finished, because a card somebody parked as `blocked` still refuses a
   * claim and a person goes looking for exactly those. The offer asks about
   * open cards alone, because those are the only ones it could have handed
   * out: counting a parked card as "withheld" reports work that was never on
   * offer, and pays for resolving its blockers to say so.
   */
  statuses: readonly ItemStatus[] = ITEM_STATUSES.filter(
    (status) => !TERMINAL_STATUSES.includes(status),
  ),
): Promise<Map<string, string[]>> {
  // Every one of them, with no cap. A cap here is not a cheaper answer, it is
  // a wrong one: the card it leaves out is offered and leased, and a claim on
  // that same card is refused, which is the loop this is here to prevent. The
  // set is bounded by how many cards use the field rather than by the size of
  // the board, and `blockedBy.0` is a plain equality the index can serve,
  // where `$ne: []` cannot.
  const waiting = (await store.items
    .find(
      { projectId, status: { $in: [...statuses] }, 'blockedBy.0': { $exists: true } },
      { projection: { slug: 1, blockedBy: 1 } },
    )
    .toArray()) as Array<Pick<ItemDoc, 'slug' | 'blockedBy'>>;
  const unmet = new Map<string, string[]>();
  if (waiting.length === 0) return unmet;

  const named = [...new Set(waiting.flatMap((row) => row.blockedBy ?? []))];
  const rows = (await store.items
    .find({ projectId, slug: { $in: named } }, { projection: { slug: 1, status: 1 } })
    .toArray()) as Array<Pick<ItemDoc, 'slug' | 'status'>>;
  const finished = new Set(
    rows.filter((row) => TERMINAL_STATUSES.includes(row.status)).map((row) => row.slug),
  );
  for (const row of waiting) {
    const left = (row.blockedBy ?? []).filter((slug) => !finished.has(slug));
    if (left.length > 0) unmet.set(row.slug, left);
  }
  return unmet;
}

/**
 * The open cards the offer must skip, as a list. Open only: a card in any
 * other status was never a candidate, and both callers use the length of this
 * to tell an agent how much work was held back from it.
 */
export async function waitingSlugs(store: Store, projectId: string): Promise<string[]> {
  return [...(await waitingBlockers(store, projectId, ['open'])).keys()];
}

export async function claimItem(
  store: Store,
  project: ProjectDoc,
  slug: string,
  agent: string,
  ttlMinutes?: number,
  /**
   * Internal: this is the second attempt after the blocker guard lost a race
   * to a change that does not block anything. Once, never in a loop, because
   * two callers editing the same list forever is a livelock and the honest
   * answer at that point is the ordinary "somebody else is writing here".
   */
  retried = false,
): Promise<ClaimResult> {
  // The handle is matched against a live claim and then written into one. An
  // object here reads as an operator on the way in and is stored as the holder
  // on the way out, which is a lease nobody can release by name.
  if (typeof agent !== 'string' || agent === '') {
    throw badRequest('bad_agent', 'agent is the handle taking this item.');
  }
  const now = new Date();
  const ttl = Math.min(Math.max(ttlMinutes ?? project.rules.claimTtlMinutes, 1), 1440);
  const expiresAt = new Date(now.getTime() + ttl * 60_000);
  // Which lease this is, so the rollback below can only ever take back the one
  // this call wrote. Two requests renewing in the same millisecond share an
  // expiry; they do not share this.
  const nonce = newId('l', 10);
  const normalized = normalizeSlug(slug);

  // Read before the lease is taken, because the refusal has to name what it is
  // refusing over. Only a card that says it waits on something costs the extra
  // query, and only on this path: reading the board never pays for it.
  const before = await store.items.findOne(
    { projectId: project._id, slug: normalized },
    { projection: { blockedBy: 1 } },
  );
  if (before) {
    const unmet = await unmetBlockers(store, project._id, before as Pick<ItemDoc, 'blockedBy'>);
    if (unmet.length > 0) {
      throw new ServiceError(409, 'blocked_by', blockedMessage(normalized, unmet), {
        blocked_by: unmet.map((row) => ({ slug: row.slug, title: row.title, status: row.status })),
      });
    }
  }

  // The list this decision was taken on goes into the filter, so a write that
  // adds a blocker between the read above and the lease below takes the lease
  // away rather than losing to it. Written as $and because the claim state is
  // already an $or and a second one at the top level would replace it.
  const snapshot = before?.blockedBy;
  const claimed = await store.items.findOneAndUpdate(
    {
      projectId: project._id,
      slug: normalized,
      $and: [
        {
          $or: [
            { claim: null },
            { 'claim.expiresAt': { $lte: now } },
            { 'claim.agent': agent },
          ],
        },
        snapshot === undefined
          ? { blockedBy: { $exists: false } }
          : { blockedBy: snapshot },
      ],
    },
    takingIt(agent, now, ttl, expiresAt, nonce),
    { returnDocument: 'after' },
  );

  if (claimed) {
    // The other half of the race, and the one a filter cannot express: a
    // blocker reopened while this was being taken. The lease is handed back
    // rather than kept, because a card whose prerequisite is open again is
    // exactly the work this refuses to hand out.
    const stillUnmet =
      (claimed.blockedBy ?? []).length === 0
        ? []
        : await unmetBlockers(store, project._id, claimed as Pick<ItemDoc, 'blockedBy'>);
    if (stillUnmet.length > 0) {
      await handBack(
        store,
        project._id,
        normalized,
        agent,
        nonce,
        blockedMessage(normalized, stillUnmet),
      );
      throw new ServiceError(409, 'blocked_by', blockedMessage(normalized, stillUnmet), {
        blocked_by: stillUnmet.map((row) => ({
          slug: row.slug,
          title: row.title,
          status: row.status,
        })),
      });
    }
    void touchAgent(store, project._id, agent);
    return { ok: true, item: claimed as ItemDoc, expiresAt };
  }

  const current = await store.items.findOne({ projectId: project._id, slug: normalized });
  if (!current) throw notFound(slug);
  // The lease may have been refused by the guard rather than by another
  // holder, and the two need different answers. Asked again against the row as
  // it is now: still waiting on something means the refusal is about that, and
  // nothing waiting means the list changed under us in a way that does not
  // stop this claim, so it is tried once more rather than reported as a
  // conflict with a holder nobody can name.
  const changed = await unmetBlockers(store, project._id, current as Pick<ItemDoc, 'blockedBy'>);
  if (changed.length > 0) {
    throw new ServiceError(409, 'blocked_by', blockedMessage(normalized, changed), {
      blocked_by: changed.map((row) => ({ slug: row.slug, title: row.title, status: row.status })),
    });
  }
  const guardLost =
    JSON.stringify(current.blockedBy ?? null) !== JSON.stringify(snapshot ?? null);
  if (guardLost && !retried) {
    return claimItem(store, project, slug, agent, ttlMinutes, true);
  }
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
      // Clearing the flag as well, because a release is an agent write like any
      // other and every other one clears it. Without this an item that hygiene
      // marked while it was held, back when held work was not exempt, would
      // keep the mark for ever: the repair pass wants a live claim, and the
      // marking pass skips anything already flagged.
      $set: {
        claim: null,
        updatedAt: now,
        touchedAt: now,
        lastActor: agent,
        stale: false,
        staleSince: null,
      },
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
    // Asking to stop holding something nobody holds is not a failure: what the
    // caller wanted is already true. This is the ordinary end of a piece of
    // work, not an edge case, because closing an item releases its claim and
    // the release in an agent's `finally` then arrives second. Refusing it made
    // the documented sequence, claim, work, close, release, end in an
    // exception. No timeline entry either: there was nothing to release, and a
    // second "released" line is noise in the record.
    //
    // Held by somebody else is still a refusal. That is the case the guard
    // exists for, and it is the opposite of this one.
    const current = await store.items.findOne({ projectId: project._id, slug: normalizeSlug(slug) });
    if (!current) {
      throw new ServiceError(404, 'not_found', `No item "${slug}" in this project.`);
    }
    // A lease that has run out is free work everywhere else in this service:
    // `/next` offers it, a claim takes it, the board counts it as unclaimed. A
    // release that refused it would be the one place where a dead claim still
    // held something, and only until the next sweep, which makes it a refusal
    // whose answer depends on when you asked.
    const held = current.claim !== null && new Date(current.claim.expiresAt) > new Date();
    if (!held) return current as ItemDoc;
    throw new ServiceError(
      409,
      'not_claim_holder',
      `"${slug}" is held by ${current.claim!.agent}, not by you.`,
    );
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
    await store.projects.updateOne({ _id: project._id }, spend('items'));
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
  /** Slug starts with this, anchored, so the unique index on the slug does the work. */
  prefix?: string;
  stale?: boolean;
  claimed?: boolean;
  limit?: number;
  includeTimeline?: boolean;
  /** Words to look for in the slug or the title, the way the board's search does. */
  q?: string;
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
function itemCursor(doc: ItemDoc, order: ItemOrder): string {
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

/**
 * Not exported, and that is the point: `readItems` is the only way in.
 *
 * A cursor handed out by `readItems` carries the walk's checkpoint after a
 * tilde, and a caller reaching past it would pass that whole string here as a
 * keyset and get `bad_cursor` for a cursor this service itself issued.
 */
async function listItems(
  store: Store,
  projectId: string,
  query: ListItemsQuery,
): Promise<ItemDoc[]> {
  const filter: Record<string, unknown> = { projectId };
  if (query.status) filter.status = query.status;
  if (query.owner) filter.owner = query.owner;
  if (query.label) filter.labels = query.label;
  if (query.source) filter.source = query.source;
  // Anchored, unlike `q`, which is a substring and scans. `^ops:` walks the
  // unique index on {projectId, slug} instead, so narrowing to one area of a
  // large board costs about what reading one card costs.
  if (query.prefix) filter.slug = { $regex: `^${escapeRegex(query.prefix)}` };
  if (query.stale !== undefined) filter.stale = query.stale;
  // An expired claim is not a claim, the same reading the board takes: an item
  // whose lease lapsed is free work, and hygiene clearing the field is a tidy-up
  // rather than the moment it became free. Listing it as held would send an
  // agent looking for a holder who left.
  const claimConditions: Record<string, unknown>[] = [];
  if (query.claimed === true) {
    claimConditions.push({ claim: { $ne: null }, 'claim.expiresAt': { $gt: new Date() } });
  }
  if (query.claimed === false) {
    claimConditions.push({
      $or: [{ claim: null }, { 'claim.expiresAt': { $lte: new Date() } }],
    });
  }

  const order: ItemOrder =
    query.order === 'id' ? 'id' : query.order === 'recent' ? 'recent' : 'urgency';
  const conditions: Record<string, unknown>[] = [...claimConditions];
  const words = wordsFilter(query.q);
  if (words) conditions.push(words);
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
  const cursor = store.items
    .find(filter, projection ? { projection } : {})
    .sort(sort)
    .limit(limit);
  // Only the searches are put on a clock. Every other filter here is answered
  // from an index and stops at the limit; a search is the one read whose cost
  // is the collection rather than the page, and it is the one read a stranger
  // holding a read link can issue without a rate limiter in front of it.
  if (words) cursor.maxTimeMS(SEARCH_BUDGET_MS);
  try {
    return (await cursor.toArray()) as ItemDoc[];
  } catch (error) {
    const stopped = words ? searchTooSlow(store, error) : null;
    if (stopped) throw stopped;
    throw error;
  }
}

/**
 * How long a search may read before it is stopped.
 *
 * A search that matches nothing reads every item in the project: a case
 * insensitive substring in either field is not indexable, and indexing the two
 * fields made it worse rather than better, since the planner then spent a
 * second choosing between them and fetched everything anyway. Measured at
 * 119ms on twenty thousand items and 1016ms on two hundred thousand.
 *
 * The cap on a project counts what is still open, so the closed work behind a
 * long lived board is bounded by nothing, and the page that carries the search
 * box is reachable by anybody holding the read link, with no rate limiter in
 * front of it. Left alone, that is one request that reads a whole collection,
 * as often as somebody cares to send it.
 *
 * Half a second is four times what the largest board a plan sells can cost, so
 * a paying board never meets this at all. Making the search itself cheap means
 * changing what it matches, from a substring anywhere to the start of a word,
 * and that is a change to what people and agents were promised rather than to
 * how it is stored. This bounds the damage without touching the promise.
 */
export const SEARCH_BUDGET_MS = 500;

/**
 * Mongo's own "that took longer than you allowed", turned into an answer.
 *
 * Null for anything else, so a caller rethrows what it did not recognise. Both
 * doors that carry a search go through here rather than each deciding what a
 * stopped search means: an empty page would say there is nothing to find, which
 * is precisely what nobody established.
 */
/**
 * The filters worth putting beside a search, and the only list of them.
 *
 * Each is a key an index can act on before a card is fetched, which is the
 * whole reason they help: a substring over two fields cannot be answered from
 * an index at all, so a search costs whatever the index has not already
 * narrowed away. Measured on twenty thousand cards, documents fetched beside
 * the same search: owner 500, source 800, status 1000, prefix 2500, and both
 * `label=` and another search word 20000, which is all of them.
 *
 * A list rather than a sentence, because this was published as prose in four
 * places and was wrong in all four. Add one here and every door says it.
 */
export const SEARCH_NARROWERS = ['status', 'owner', 'source', 'prefix'] as const;

export function searchTooSlow(store: Store, error: unknown): ServiceError | null {
  const failure = error as { code?: unknown; codeName?: unknown } | null;
  if (failure?.code !== 50 && failure?.codeName !== 'MaxTimeMSExpired') return null;
  // Counted, because otherwise the only evidence that a board outgrew its
  // search is somebody mentioning that the box stopped working. This is also
  // the trigger the search decision was deferred on: not a percentile nothing
  // computes, but "has this ever happened here at all".
  record(store, 'refused', { door: 'http', detail: 'search_too_slow' });
  return new ServiceError(
    503,
    'search_too_slow',
    `That search read for longer than ${SEARCH_BUDGET_MS}ms without finishing, so it was stopped rather than answered with a page that might be missing rows. Narrow it with ${SEARCH_NARROWERS.map((name) => `${name}=`).join(', ')} beside it, which are the ones that bound what gets read. Another word narrows the answer but not the read, and neither does label=. An empty answer would have said there is nothing to find, which is not what happened.`,
  );
}

/**
 * Somebody's words, turned into a filter over the slug and the title.
 *
 * Every word has to appear, in either field, in any order: typing two words
 * that happen to sit at opposite ends of a title is the ordinary case, and a
 * search that treats the whole string as one phrase answers nothing and reads
 * as broken. Escaped, because these are words and not a pattern: a stray
 * bracket finds nothing rather than throwing. Six words is the cap, since each
 * one costs a scan and nobody searching a board types a sentence.
 *
 * Exported so the board's search box and the item list ask the same question.
 * They had two copies of this, which agreed only by luck.
 */
export const SEARCH_MAX_CHARS = 120;

/**
 * What a query means once, so nothing normalizes it a second way.
 *
 * Cut rather than refused, because a search box that answers 400 on a long
 * paste is worse than one that searches the first hundred characters of it.
 * Trimmed before it is cut: the board used to slice the raw string, so a
 * hundred and twenty spaces followed by a word searched for nothing there and
 * for the word everywhere else.
 */
export function normalizeSearch(q: string | undefined): string {
  return (q ?? '').trim().slice(0, SEARCH_MAX_CHARS);
}

export function wordsFilter(q: string | undefined): Record<string, unknown> | null {
  const words = normalizeSearch(q).split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return null;
  return {
    $and: words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .map((word) => ({
        $or: [
          { slug: { $regex: word, $options: 'i' } },
          { title: { $regex: word, $options: 'i' } },
        ],
      })),
  };
}

/**
 * A page of items, with the two things a caller needs to ask for the next one.
 *
 * Behind both doors on purpose. The HTTP route grew paging, an `id` order for
 * exports and a `since` window for change feeds; the MCP tool kept the six
 * filters it was born with, so an agent on that door could not read past its
 * limit, could not sync incrementally, and was told in the tool description
 * that it could filter by claim state, which it could not. Two implementations
 * of one behaviour drift, and this is what that drift looks like.
 */
export interface ReadItemsInput {
  status?: ItemStatus | undefined;
  owner?: string | undefined;
  label?: string | undefined;
  source?: string | undefined;
  prefix?: string | undefined;
  stale?: boolean | undefined;
  claimed?: boolean | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  order?: string | undefined;
  cursor?: string | undefined;
  since?: string | Date | undefined;
}

export interface ReadItemsResult {
  items: ItemDoc[];
  /** Null on a short page, so a caller learns it is done without one more read. */
  nextCursor: string | null;
  asOf: Date;
}

/**
 * The checkpoint travels inside the cursor, after a `~`.
 *
 * `as_of` is the moment a caller hands back as `since` next time, and paging
 * has to hand back the same one on every page or an incremental read loses
 * work. A write that lands while somebody is on page three sorts above their
 * cursor, so it is on no later page; it is newer than the first page's
 * checkpoint, so saving that one picks it up on the next poll. Saving the last
 * page's, freshly stamped, starts the next poll after it, and it is gone.
 *
 * A cursor with no `~` is one issued before this existed and simply gets a new
 * checkpoint, which is what it had all along. One that has a `~` and no
 * readable date after it is damaged rather than old, and it is refused: going
 * on would stamp a fresh checkpoint halfway through somebody's walk, which is
 * the exact loss this exists to prevent.
 */
function splitCursor(cursor: string | undefined): { keyset?: string; asOf?: Date } {
  if (!cursor) return {};
  const at = cursor.lastIndexOf('~');
  if (at === -1) return { keyset: cursor };
  const carried = new Date(cursor.slice(at + 1));
  if (Number.isNaN(carried.getTime())) {
    throw new ServiceError(
      400,
      'bad_cursor',
      'That cursor is damaged: what follows the "~" is not a timestamp. Start the walk again rather than paging on, or this read would step over whatever changed while you were paging.',
    );
  }
  return { keyset: cursor.slice(0, at), asOf: carried };
}

export async function readItems(
  store: Store,
  project: Pick<ProjectDoc, '_id' | 'rules'>,
  input: ReadItemsInput,
): Promise<ReadItemsResult> {
  // Runs from in here rather than from the routes, because putting the trigger
  // on one door is how the first version of this shipped, with the other door
  // left behind again.
  //
  // Leases only, and not the rest of hygiene: a lapsed lease is free work the
  // moment it lapses, but the row does not change until something clears it,
  // so a caller polling claimed=false with since= would never be told. Closing
  // and marking are the timer's job, so that reading the board cannot end
  // anybody's work.
  void maybeExpireClaims(store, project).catch(() => undefined);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const order: ItemOrder =
    input.order === 'id' ? 'id' : input.order === 'recent' ? 'recent' : 'urgency';
  const since =
    input.since === undefined
      ? undefined
      : input.since instanceof Date
        ? input.since
        : new Date(String(input.since));
  if (since && Number.isNaN(since.getTime())) {
    throw new ServiceError(400, 'bad_since', 'since must be an ISO timestamp.');
  }
  // The four narrowings that land in the filter, checked here rather than at a
  // door: the HTTP schema refuses a non-string, MCP arguments are whatever a
  // model produced, and a status arriving as `{"$ne": "done"}` was a query
  // somebody wrote into a filter that is supposed to take a word.
  if (input.status !== undefined && !ITEM_STATUSES.includes(input.status)) {
    throw badRequest('bad_status', `Status must be one of ${ITEM_STATUSES.join(', ')}.`);
  }
  for (const [name, value] of [
    ['owner', input.owner],
    ['label', input.label],
    ['source', input.source],
    ['prefix', input.prefix],
    ['q', input.q],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') {
      throw badRequest('bad_filter', `${name} is a word to narrow by, not a query.`);
    }
  }
  const { keyset, asOf: carried } = splitCursor(input.cursor);
  // Stamped before the read, never after: anything written while this query
  // ran must fall inside the next window rather than between them.
  const asOf = carried ?? new Date();
  const items = await listItems(store, project._id, {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
    ...(input.stale === undefined ? {} : { stale: input.stale }),
    ...(input.claimed === undefined ? {} : { claimed: input.claimed }),
    ...(input.q ? { q: input.q } : {}),
    ...(keyset === undefined ? {} : { cursor: keyset }),
    ...(since ? { since } : {}),
    limit,
    order,
  });
  return {
    items,
    nextCursor:
      items.length === limit
        ? `${itemCursor(items[items.length - 1]!, order)}~${asOf.toISOString()}`
        : null,
    asOf,
  };
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
  /** Whether this call also took the lease, when it was asked to. */
  claimed?: boolean;
}

/**
 * The same offer, held for whoever asked.
 *
 * `GET /next` deliberately does not claim, because reading what is next and taking
 * it are different decisions and an agent that only wants to look should not
 * have to release afterwards. The cost shows up on a fleet: ten loops asking at
 * once are all offered the same item, one wins the claim that follows and nine
 * spend a round trip losing. This does both in one call, and on losing the race
 * it asks again rather than handing back a refusal, because the item it would
 * refuse with is one somebody else is already working.
 */
export async function nextItemHeld(
  store: Store,
  project: ProjectDoc,
  handle: string,
  ttlMinutes?: number,
): Promise<NextResult> {
  if (typeof handle !== 'string' || handle === '') {
    throw badRequest('bad_agent', 'Claiming what comes next needs the handle it is for.');
  }
  const now = new Date();
  const ttl = Math.min(Math.max(ttlMinutes ?? project.rules.claimTtlMinutes, 1), 1440);
  const expiresAt = new Date(now.getTime() + ttl * 60_000);
  const nonce = newId('l', 10);

  // Held already, and handed back rather than claimed again: a session that
  // restarts must be given the work it took, or it abandons it for an hour.
  const own = await store.items.findOne({
    projectId: project._id,
    status: 'open',
    'claim.agent': handle,
    'claim.expiresAt': { $gt: now },
  });
  if (own) {
    return { item: own as ItemDoc, reason: 'you already hold this claim, finish or release it', claimed: true };
  }

  const agent = await store.agents.findOne({ projectId: project._id, handle });
  const free = {
    projectId: project._id,
    status: 'open' as const,
    $or: [{ claim: null }, { 'claim.expiresAt': { $lte: now } }],
  };
  // The selection and the claim are one update, sorted the way the offer is
  // sorted. Choosing and then taking was two round trips with a gap in the
  // middle, and ten loops asking at the same moment all read the same item out
  // of that gap: one took it and nine lost, which is the round trip this call
  // exists to save.
  const take = async (filter: Record<string, unknown>) => {
    const taken = await store.items.findOneAndUpdate(
      filter,
      takingIt(handle, now, ttl, expiresAt, nonce),
      { sort: { priority: -1, touchedAt: 1 }, returnDocument: 'after' },
    );
    if (!taken) return null;
    // The card was chosen from a list of what was free a moment ago, and a
    // blocker can be reopened, or added, inside that moment. Handed back
    // rather than kept: work whose prerequisite is open again is the one thing
    // this call is not allowed to hand out, and the caller asking again gets a
    // card it can actually do.
    const unmet =
      (taken.blockedBy ?? []).length === 0
        ? []
        : await unmetBlockers(store, project._id, taken as Pick<ItemDoc, 'blockedBy'>);
    if (unmet.length === 0) return taken;
    await handBack(
      store,
      project._id,
      taken.slug,
      handle,
      nonce,
      blockedMessage(taken.slug, unmet),
    );
    return null;
  };

  // A card whose blockers are unfinished is not offered, because offering it
  // and then refusing the claim is a loop an agent cannot get out of. Computed
  // per call rather than kept as a counter: two queries when a board uses the
  // field at all, nothing to maintain when a blocker closes, and nothing that
  // can drift.
  const waiting = await waitingSlugs(store, project._id);
  if (waiting.length > 0) Object.assign(free, { slug: { $nin: waiting } });

  const scope = agent?.scope ?? [];
  if (scope.length > 0) {
    const scoped = await take({
      ...free,
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
    });
    if (scoped) {
      void touchAgent(store, project._id, handle);
      return { item: scoped as ItemDoc, reason: 'in your declared scope', claimed: true };
    }
    const otherCount = await store.items.countDocuments(free, { limit: 50 });
    return {
      item: null,
      claimed: false,
      reason:
        otherCount > 0
          ? `nothing open in your scope; ${otherCount} open ${otherCount === 1 ? 'item belongs' : 'items belong'} to other scopes. Widen your scope on purpose, or leave them alone.`
          : 'nothing open in this project',
    };
  }

  const any = await take(free);
  if (any) {
    void touchAgent(store, project._id, handle);
    return { item: any as ItemDoc, reason: 'oldest untouched open item', claimed: true };
  }
  return { item: null, claimed: false, reason: 'nothing open in this project' };
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
  // The handle goes into two filters below, one of them the lookup that decides
  // whose scope this offer respects. An object there matched no agent and was
  // handed unscoped work instead of a refusal.
  if (handle !== undefined && handle !== null && typeof handle !== 'string') {
    throw badRequest('bad_agent', 'agent is the handle asking for work.');
  }
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

  const base: Record<string, unknown> = {
    projectId: project._id,
    status: 'open' as const,
    $or: [{ claim: null }, { 'claim.expiresAt': { $lte: now } }],
  };
  // Same rule as the call that takes one: an offer a claim would refuse is
  // worse than no offer, and the count is said out loud so a board that looks
  // emptier than it is explains itself.
  const waiting = await waitingSlugs(store, project._id);
  if (waiting.length > 0) base.slug = { $nin: waiting };
  const alsoWaiting =
    waiting.length === 0
      ? ''
      : `; ${waiting.length} ${waiting.length === 1 ? 'item is' : 'items are'} waiting on other cards`;
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
          ? `nothing open in your scope; ${otherCount} open ${otherCount === 1 ? 'item belongs' : 'items belong'} to other scopes. Widen your scope on purpose, or leave them alone.${alsoWaiting}`
          : `nothing open in this project${alsoWaiting}`,
    };
  }

  const any = await store.items.find(base).sort(sort).limit(1).toArray();
  return any[0]
    ? { item: any[0] as ItemDoc, reason: 'oldest untouched open item' }
    : { item: null, reason: `nothing open in this project${alsoWaiting}` };
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
  door: EventDoor,
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
    notifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.escalations.insertOne({ ...doc, expiresAt: project.expiresAt });
  await store.projects.updateOne({ _id: project._id }, charge('escalations'));

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
  // After the write, not before: a question the cap refused was never filed,
  // and a log that says otherwise is worse than no log. Here rather than at the
  // routes because the MCP door, which is how most agents arrive, was the one
  // not counting.
  record(store, 'escalate', { door, projectId: project._id });
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
  door: EventDoor,
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
  // Guarded on the answer as well as the status, which the sentence above
  // already claimed: two identical retries of an answer that only edits the
  // text both match a guard that reads the status alone, so both succeed and
  // both count. The second one now finds the row already moved and takes the
  // read-back path below, where nothing is recorded.
  const doc = await store.escalations.findOneAndUpdate(
    { projectId, _id: id, status: before.status, answer: before.answer },
    {
      $set: {
        status,
        answer,
        updatedAt: now,
        // Only when something changed. A client retrying an identical answer
        // after a timeout is not a new decision, and this date is read as
        // recency: the history a person sees is ordered by it, so a retry of
        // last week's answer would climb over this morning's.
        ...(changed
          ? { answeredAt: now, acknowledgedAt: null, acknowledgedBy: null, acknowledgedNote: null }
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
      isOpen ? charge('escalations') : spend('escalations'),
    );
  }
  // Counted here rather than at the three routes that call this, because it was
  // counted at one of them: answers through the capability link and through the
  // API left no trace, so the log said every human decision arrived on the
  // operator's page. That page is not where the mail sends them. A split like
  // that is how a door that works gets removed for being unused.
  //
  // Only when the decision changed something, and only when it is a decision.
  // Putting a question back in the queue is the opposite of answering it, and
  // `open` is one of the four states this route accepts, so counting every
  // change would let a withdrawn answer raise the number of answers. A client
  // retrying an identical answer after a timeout is one decision too, and the
  // guarded update above treats it as one.
  if (changed && !isOpen) record(store, 'answer', { door, projectId });
  return doc as EscalationDoc;
}

// --------------------------------------------------------------- api keys

export async function createApiKey(
  store: Store,
  project: ProjectDoc,
  input: { name?: string; role?: 'write' | 'admin'; ttlMs?: number },
): Promise<{ key: ApiKeyDoc; token: string; expiresAt: Date | null }> {
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
  // A key given a lifetime of its own still cannot outlive the project it
  // belongs to, so the two expiries take whichever comes first.
  const own = input.ttlMs ? new Date(now.getTime() + input.ttlMs) : null;
  const expiresAt =
    own && project.expiresAt
      ? new Date(Math.min(own.getTime(), project.expiresAt.getTime()))
      : (own ?? project.expiresAt);
  // Marked, because claiming a project clears the expiry off everything that
  // was only expiring because the project was. This one is not.
  await store.keys.insertOne({ ...key, expiresAt, ...(own ? { ownExpiry: true } : {}) });
  return { key, token, expiresAt };
}

export async function listApiKeys(
  store: Store,
  projectId: string,
): Promise<Array<ApiKeyDoc & { expiresAt?: Date | null }>> {
  return store.keys
    .find({ projectId }, { projection: { hash: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
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
