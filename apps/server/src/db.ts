import type { IndexDescription } from 'mongodb';
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { EventDoc } from './events.js';
import type {
  AgentDoc,
  ApiKeyDoc,
  ClaimCodeDoc,
  EscalationDoc,
  ItemDoc,
  ProjectDoc,
  ShareDoc,
  HandoverRequestDoc,
} from './types.js';

/**
 * Children of a demo project carry their own `expiresAt` so the TTL index
 * disposes of them without an orphan sweeper. Claiming a project clears the
 * field on every child in one updateMany, which happens at most once per
 * project.
 */
export type Expiring<T> = T & { expiresAt?: Date | null };

/** An OAuth client registered through RFC 7591 dynamic client registration. */
export interface OAuthClientDoc {
  _id: string;
  projectId: string;
  secretHash: string;
  name: string;
  createdAt: Date;
  expiresAt?: Date | null;
}

/**
 * A long-lived link that shows one person every project they claimed, and every
 * question waiting on them across all of those projects at once.
 */
export interface OperatorTokenDoc {
  _id: string;
  email: string;
  hash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * A browser session for one operator. The credential is a cookie, so it never
 * reaches a log, a URL or a Referer header, and it carries the CSRF secret for
 * the forms that session renders.
 */
export interface OperatorSessionDoc {
  _id: string;
  email: string;
  hash: string;
  csrf: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

/**
 * The names one person answers to in an item's `owner` field.
 *
 * `owner` is free text an agent wrote, usually a first name, and the operator
 * is an email address. Nothing connects the two until somebody says so, which
 * is what this is: a short list per address, declared once, so "everything
 * waiting on me" can mean the work as well as the questions.
 */
export interface OperatorAliasDoc {
  _id: string;
  email: string;
  aliases: string[];
  updatedAt: Date;
}

/** A six digit code that lets somebody start a session with their address. */
export interface OperatorCodeDoc {
  _id: string;
  email: string;
  codeHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface Store {
  client: MongoClient;
  db: Db;
  projects: Collection<ProjectDoc>;
  oauthClients: Collection<OAuthClientDoc>;
  operatorTokens: Collection<OperatorTokenDoc>;
  operatorSessions: Collection<OperatorSessionDoc>;
  operatorCodes: Collection<OperatorCodeDoc>;
  operatorAliases: Collection<OperatorAliasDoc>;
  events: Collection<EventDoc>;
  agents: Collection<Expiring<AgentDoc>>;
  items: Collection<Expiring<ItemDoc>>;
  escalations: Collection<Expiring<EscalationDoc>>;
  keys: Collection<Expiring<ApiKeyDoc>>;
  claimCodes: Collection<ClaimCodeDoc>;
  shares: Collection<ShareDoc>;
  handovers: Collection<HandoverRequestDoc>;
  /**
   * Whether the indexes and migrations this code expects are actually there.
   *
   * A connection is not readiness. Between the client connecting and the
   * indexes being built there is a window where every query works and one of
   * them is missing a unique constraint, and a write landing in it can both
   * break an invariant and make the index build fail, leaving a deployment
   * that looks healthy and is not. A mutable box because it is one process
   * telling the rest of itself something that changes exactly twice.
   */
  ready: { ok: boolean; why: string | null };
  close(): Promise<void>;
}

/**
 * The collections, and nothing done to them.
 *
 * Split out for the tools that read production with a credential that may not
 * be allowed to write, and for the one that promises in its own header that it
 * never writes. `createStore` builds the indexes and runs the migrations, which
 * is right for a server starting up and wrong for a report: a read only report
 * that quietly creates an index is a report that fails on a read only
 * connection, and a promise nobody can rely on.
 */
export async function connectStore(uri: string, dbName: string): Promise<Store> {
  const store = openStore(uri, dbName);
  await store.client.connect();
  return store;
}

/**
 * The handles, without asking whether anything is listening.
 *
 * Nothing here touches the network: a collection is a name and a client, and
 * the client only goes looking for a server when somebody runs a command. That
 * is what lets the process bind its port before the database is up, answer
 * every call with the 503 it would answer anyway, and start serving the moment
 * the database arrives. Awaiting a connection first meant a blip during a
 * deploy exited the process, and Heroku backs a crashing dyno off for minutes,
 * so a database that came back in twenty seconds still left the site down.
 */
export function openStore(
  uri: string,
  dbName: string,
  // Overridable so the test that proves a process serves without a database
  // does not have to wait out the real timeout five seconds at a time.
  options: { serverSelectionTimeoutMS?: number } = {},
): Store {
  const client = new MongoClient(uri, {
    // Agents call this in a loop; a request should fail fast rather than hang
    // on a wedged primary and burn the caller's own timeout budget.
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 5_000,
    connectTimeoutMS: 5_000,
    maxPoolSize: 20,
  });
  const db = client.db(dbName);

  const store: Store = {
    client,
    db,
    projects: db.collection<ProjectDoc>('projects'),
    oauthClients: db.collection<OAuthClientDoc>('oauthClients'),
    operatorTokens: db.collection<OperatorTokenDoc>('operatorTokens'),
    operatorSessions: db.collection<OperatorSessionDoc>('operatorSessions'),
    operatorCodes: db.collection<OperatorCodeDoc>('operatorCodes'),
    operatorAliases: db.collection<OperatorAliasDoc>('operatorAliases'),
    events: db.collection<EventDoc>('events'),
    agents: db.collection<Expiring<AgentDoc>>('agents'),
    items: db.collection<Expiring<ItemDoc>>('items'),
    escalations: db.collection<Expiring<EscalationDoc>>('escalations'),
    keys: db.collection<Expiring<ApiKeyDoc>>('apiKeys'),
    claimCodes: db.collection<ClaimCodeDoc>('claimCodes'),
    shares: db.collection<ShareDoc>('shares'),
    handovers: db.collection<HandoverRequestDoc>('handoverRequests'),
    ready: { ok: false, why: 'the store has not finished starting' },
    close: () => client.close(),
  };

  return store;
}

/**
 * Driver errors that mean the store, not the request.
 *
 * Named rather than matched on a prefix, because MongoServerError is a query
 * this service got wrong and reads as one of these to any pattern loose enough
 * to be convenient. Shared by both doors, because a client that branches on
 * the code should get the same one whichever it came in through.
 */
const UNREACHABLE = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoServerClosedError',
  'MongoTopologyClosedError',
  'MongoClientClosedError',
  'MongoOperationTimeoutError',
]);

/**
 * Server codes that mean the node is going away, not that the query was wrong.
 *
 * A failover does not always arrive as a network error. The client reaches a
 * node, the node answers, and what it answers is that it is no longer the
 * primary or that it is shutting down: a MongoServerError, class for class
 * identical to "unknown operator: $nope", which is a bug that will still be a
 * bug in five seconds. The number is what separates them.
 */
const UNAVAILABLE_CODES = new Set([
  6, // HostUnreachable
  7, // HostNotFound
  89, // NetworkTimeout
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  9001, // SocketException
  10107, // NotWritablePrimary
  11600, // InterruptedAtShutdown
  11602, // InterruptedDueToReplStateChange
  13435, // NotPrimaryNoSecondaryOk
  13436, // NotPrimaryOrSecondary
  // A read, not a write, and the one a failover produces on the way back up:
  // the new primary is elected but has not yet committed a majority, so a
  // read concern that asks for one is refused until it has. The driver's
  // retryable-write label is never on this, because it is not a write.
  134, // ReadConcernMajorityNotAvailableYet
]);

export function storeUnreachable(error: unknown): boolean {
  const thrown = error as
    | { name?: string; code?: unknown; hasErrorLabel?: (label: string) => boolean }
    | null
    | undefined;
  if (!thrown) return false;
  if (UNREACHABLE.has(thrown.name ?? '')) return true;
  // The driver's own answer to "is this worth sending again", attached the
  // moment it works out that the topology moved under it. Asking it beats
  // keeping a list of codes in step with a database we do not write.
  if (typeof thrown.hasErrorLabel === 'function' && thrown.hasErrorLabel('RetryableWriteError')) {
    return true;
  }
  return typeof thrown.code === 'number' && UNAVAILABLE_CODES.has(thrown.code);
}

export async function createStore(uri: string, dbName: string): Promise<Store> {
  const store = await connectStore(uri, dbName);
  await ensureIndexes(store);
  await runMigrations(store);
  store.ready = { ok: true, why: null };
  return store;
}

/**
 * Small, idempotent repairs run at boot.
 *
 * Adding a field to a document type leaves every older document without it, and
 * a MongoDB sort puts missing values behind every present one. An urgent
 * question filed before the field existed would sit below a new low-priority
 * one, which is precisely the bug the field was added to fix.
 */
export async function runMigrations(store: Store): Promise<void> {
  /**
   * A handle is trimmed now, wherever it came in.
   *
   * It was not always, and the two doors disagreed: the HTTP schema capped it
   * while MCP passed whatever a model produced. Every reader that compares a
   * handle then had to look for two shapes, and defending that invariant
   * instead of establishing it cost three rounds of review, each finding a
   * different place the raw shape had leaked into: an inbox that came back
   * empty, a card whose timeline named an agent nobody had registered.
   *
   * Measured before writing this: zero rows in production hold an untrimmed
   * handle. It exists for a deployment that upgrades with older rows, so that
   * every reader downstream can compare one shape and mean it.
   */
  // Exactly the twenty five code points `String.prototype.trim` strips, asked
  // of JavaScript rather than assumed. `$trim` has its own default set, which
  // both misses some of these and includes U+0000, which JavaScript keeps: left
  // to itself it would strand a handle padded with an ideographic space and
  // silently merge one padded with a null into somebody else's identity. The
  // point of this migration is that one function decides what a handle is.
  const TRIMS = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003'
    + '\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  await store.escalations.updateMany(
    { $expr: { $ne: ['$agent', { $trim: { input: '$agent', chars: TRIMS } }] } },
    [{ $set: { agent: { $trim: { input: '$agent', chars: TRIMS } } } }],
  );

  await store.escalations.updateMany({ priorityRank: { $exists: false } }, [
    {
      $set: {
        priorityRank: {
          $switch: {
            branches: [
              { case: { $eq: ['$priority', 'urgent'] }, then: 3 },
              { case: { $eq: ['$priority', 'high'] }, then: 2 },
              { case: { $eq: ['$priority', 'low'] }, then: 0 },
            ],
            default: 1,
          },
        },
      },
    },
  ]);

  /**
   * A project that already holds work was activated before the marker existed.
   *
   * Without this, every project that predates the field looks unactivated, and
   * its next new item records a second activation years after the first. The
   * marker answers "has this happened", not "exactly when", so a backfilled one
   * carries the project's own creation time; only its presence is ever read.
   *
   * Cheap after the first run: only projects still missing the marker are
   * considered, which by then is the ones created since boot with no items yet.
   */
  const BATCH = 500;
  // Paged by id rather than by re-reading the filter. A project with no items
  // never gets a marker, so it stays in the filter forever: without a cursor
  // the same first page would come back every time and the loop would never
  // reach the ones behind it. Collecting every id into a single $in is the
  // other way to get this wrong, because past the command size limit it throws,
  // and this runs before the server finishes booting.
  let after: string | null = null;
  for (;;) {
    const page = await store.projects
      .find(
        {
          firstWriteAt: { $exists: false },
          ...(after === null ? {} : { _id: { $gt: after } }),
        },
        { projection: { _id: 1 } },
      )
      .sort({ _id: 1 })
      .limit(BATCH)
      .toArray();
    if (page.length === 0) break;

    const ids = page.map((project) => project._id);
    const written = await store.items.distinct('projectId', { projectId: { $in: ids } });
    if (written.length > 0) {
      await store.projects.updateMany({ _id: { $in: written } }, [
        { $set: { firstWriteAt: '$createdAt' } },
      ]);
    }
    after = ids[ids.length - 1]!;
    if (page.length < BATCH) break;
  }

  /**
   * When a notice about a project last left, for the projects that were sending
   * them before the field existed.
   *
   * Without this, every board that has been mailing its owner for weeks reports
   * "no notice has ever gone out" on the first read after the deploy, and the
   * watchdog reads that beside an old unanswered question as a dead mail path.
   * A false alarm about the alerting itself is worse than most false alarms.
   *
   * The value is exact rather than approximate: an escalation's `notifiedAt` is
   * stamped in the same success path as the project field, so the newest one a
   * project has is precisely when its last notice went out.
   *
   * Runs on every boot rather than once, because a claimed project that has
   * never had a question is missing this field legitimately and always will be,
   * so there is no "everything is backfilled" state to detect. Which is exactly
   * why it is driven from the projects that lack it, in pages, and writes a
   * page in one round trip: asking the whole escalation history instead, and
   * then updating project by project, would have grown with every project that
   * ever sent a notice and would have been paid at every restart, for nothing.
   */
  let unstamped: string | null = null;
  for (;;) {
    const page = await store.projects
      .find(
        {
          escalationNoticeSentAt: { $exists: false },
          ...(unstamped === null ? {} : { _id: { $gt: unstamped } }),
        },
        { projection: { _id: 1 } },
      )
      .sort({ _id: 1 })
      .limit(BATCH)
      .toArray();
    if (page.length === 0) break;

    const ids = page.map((project) => project._id);
    const lastNotices = await store.escalations
      .aggregate<{ _id: string; last: Date }>([
        { $match: { projectId: { $in: ids }, notifiedAt: { $ne: null } } },
        { $group: { _id: '$projectId', last: { $max: '$notifiedAt' } } },
      ])
      .toArray();
    if (lastNotices.length > 0) {
      await store.projects.bulkWrite(
        lastNotices.map((notice) => ({
          updateOne: {
            filter: { _id: notice._id, escalationNoticeSentAt: { $exists: false } },
            update: { $set: { escalationNoticeSentAt: notice.last } },
          },
        })),
      );
    }
    unstamped = ids[ids.length - 1]!;
    if (page.length < BATCH) break;
  }
}

/**
 * Create indexes, and survive one of them having changed shape.
 *
 * MongoDB refuses to redefine an index that already exists under the same name
 * with different options, and it refuses by throwing, which on this path means
 * the process never finishes booting. That is how a one word change (a plain
 * index becoming unique) turns into an instance that will not start against a
 * database that has run the previous version, which is every deploy. Dropping
 * the old one and asking again is the only thing the caller ever wants here.
 */
/** The two ways MongoDB says "that name is taken by a different index". */
const INDEX_CONFLICT = new Set([85, 86]);

/**
 * What makes two indexes the same index, for the one purpose of deciding
 * whether one stands in the way of the other.
 *
 * The name is not part of it, and everything the database treats as a
 * difference is: a hidden index is invisible to the planner, a collation
 * changes what counts as a duplicate, and two indexes on one key with
 * different partial filters are two indexes MongoDB is happy to hold at once.
 *
 * Exported because `tools/index-drift.mts` asks the same question of a running
 * deployment, and two answers to "is this the same index" is how a checker ends
 * up certifying a database the boot cannot start against.
 */
export function indexShape(index: Record<string, unknown>): string {
  return [
    JSON.stringify(index.key),
    index.unique ? 'unique' : '',
    index.expireAfterSeconds === undefined ? '' : `ttl=${String(index.expireAfterSeconds)}`,
    index.partialFilterExpression ? `partial=${JSON.stringify(index.partialFilterExpression)}` : '',
    index.sparse ? 'sparse' : '',
    index.hidden ? 'hidden' : '',
    index.collation ? `collation=${JSON.stringify(index.collation)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

interface IndexedCollection {
  createIndexes: (specs: IndexDescription[]) => Promise<unknown>;
  dropIndex: (name: string) => Promise<unknown>;
  indexes: () => Promise<Array<Record<string, unknown>>>;
}

async function ensure(collection: IndexedCollection, specs: IndexDescription[]): Promise<void> {
  try {
    await collection.createIndexes(specs);
    return;
  } catch (error) {
    // 86 is IndexKeySpecsConflict: same name, different key. 85 is
    // IndexOptionsConflict: same name and key, different options, which is
    // what a sparse index becoming a partial one raises. Both mean the same
    // thing to the only caller this has: the definition moved, replace it.
    if (!INDEX_CONFLICT.has((error as { code?: number }).code ?? 0)) throw error;
  }

  // One at a time, so a redefinition replaces the index it redefines and
  // nothing else. Dropping the whole set took the unique slug index with it,
  // and on a deployment still serving requests a single upsert inside that
  // window writes the duplicate that makes the rebuild fail, which means the
  // process never finishes booting and the fix is by hand, in production.
  for (const spec of specs) {
    try {
      await collection.createIndexes([spec]);
    } catch (error) {
      if (!INDEX_CONFLICT.has((error as { code?: number }).code ?? 0) || !spec.name) throw error;
      // Everything standing in the way, by the name it is actually under.
      //
      // There are two ways to be in the way and they can both be true at once:
      // something else holds the name being asked for, and the key being asked
      // for sits under some other name. Dropping only the name leaves the key
      // conflict; dropping only the key holder leaves the name taken, and the
      // retry meets the same refusal after having thrown away a live index.
      // Either way the process never finishes booting, which is the failure
      // this whole function exists to prevent.
      const live = await collection.indexes().catch(() => []);
      const wanted = indexShape(spec as unknown as Record<string, unknown>);
      const blocking = new Set<string>();
      for (const one of live) {
        const name = typeof one.name === 'string' ? one.name : '';
        if (!name || name === '_id_') continue;
        // The name being asked for, whatever is under it, and an index that is
        // already this one under another name. Not every index on the same
        // key: MongoDB is content to hold two of those when their options
        // differ, so a partial index somebody built by hand for a slow query
        // is theirs to keep, and dropping it here would be this function
        // helping itself to the database on the way past.
        if (name === spec.name || indexShape(one) === wanted) blocking.add(name);
      }
      for (const name of blocking) await collection.dropIndex(name).catch(() => undefined);
      await collection.createIndexes([spec]);
    }
  }
}

export async function ensureIndexes(store: Store): Promise<void> {
  await Promise.all([
    ensure(store.projects, [
      { key: { readToken: 1 }, unique: true, name: 'readToken' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
      { key: { claimedBy: 1 }, name: 'claimedBy', sparse: true },
    ]),
    ensure(store.agents, [
      { key: { projectId: 1, handle: 1 }, unique: true, name: 'handle' },
      { key: { projectId: 1, lastSeenAt: -1 }, name: 'recent' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.items, [
      // The idempotency key. Two sessions describing the same problem converge
      // on one document instead of two, which is the whole point of the slug.
      { key: { projectId: 1, slug: 1 }, unique: true, name: 'slug' },
      { key: { projectId: 1, status: 1, priority: -1, touchedAt: 1 }, name: 'queue' },
      { key: { projectId: 1, source: 1 }, name: 'source', sparse: true },
      // Powers the "somebody already filed this" hint on insert.
      { key: { projectId: 1, titleKey: 1 }, name: 'titleKey' },
      { key: { projectId: 1, 'claim.expiresAt': 1 }, name: 'claims', sparse: true },
      // Read on both offer paths, and only ever for the cards that use the
      // field. Partial rather than sparse: a compound sparse index still holds
      // every document as soon as one of its fields exists, and `projectId` is
      // on all of them, so `sparse` here would have indexed the whole board
      // while reading as if it did not.
      {
        key: { projectId: 1, 'blockedBy.0': 1 },
        name: 'waiting',
        partialFilterExpression: { 'blockedBy.0': { $exists: true } },
      },
      // The three orders a page of items can be asked for, each with the
      // tiebreaker the keyset cursor pages on, because a sort the index cannot
      // finish is a sort of the whole project in memory: measured at fifty
      // thousand keys walked for a page of fifty.
      { key: { projectId: 1, priority: -1, updatedAt: -1, _id: -1 }, name: 'urgency' },
      { key: { projectId: 1, updatedAt: -1, _id: -1 }, name: 'recent' },
      { key: { projectId: 1, _id: 1 }, name: 'stable' },
      // Stale work, across a fleet, for the operator's page. Partial because
      // the flag is rare by design: an index over the ones that are not stale
      // would be the collection again, paid for on every write.
      {
        key: { projectId: 1, staleSince: 1 },
        name: 'stale',
        partialFilterExpression: { stale: true },
      },
      // The other direction, for the pass that decides what became stale: not
      // terminal, not already flagged, untouched since a cutoff. It is the most
      // expensive thing hygiene does, it runs every five minutes per project,
      // and without this it reads every open item the project holds.
      { key: { projectId: 1, status: 1, stale: 1, touchedAt: 1 }, name: 'staleScan' },
      // Two of the lists behind the filter dropdowns on the board page, each of
      // which is a `distinct` over the project. With an index that is a walk of
      // the distinct values and nothing else; without one it is a scan of every
      // item, on every load of the busiest page a person opens.
      //
      // `status` is in the key because a board that keeps finished work off
      // itself asks its filters for the same narrower set, and that predicate
      // between the project and the field being walked is enough to cost the
      // walk: 80ms and seventy seven thousand documents fetched, against 1ms
      // and eight keys with this key. It serves the wider question too, so the
      // board that shows everything is not paying for the one that does not.
      //
      // The third list, the labels, deliberately has no index. Labels are an
      // array, so any index over them is multikey, and a multikey index cannot
      // answer a `distinct` without fetching the documents behind the keys: it
      // was measured at 175ms either way on two hundred thousand items, while
      // making every write to an item pay for a second index. An index that
      // costs writes and buys no read is worse than no index.
      { key: { projectId: 1, status: 1, owner: 1 }, name: 'owners' },
      { key: { projectId: 1, status: 1, lastActor: 1 }, name: 'actors' },
      // Items created and never described, for the pass that drops them.
      // Partial because that is a handful of documents on any board, and an
      // index over the ones that do have a body is the collection again.
      {
        key: { projectId: 1, createdAt: 1 },
        name: 'undescribed',
        partialFilterExpression: { body: '' },
      },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.escalations, [
      { key: { projectId: 1, status: 1, createdAt: -1 }, name: 'inbox' },
      { key: { projectId: 1, status: 1, priorityRank: -1, createdAt: 1 }, name: 'queue' },
      { key: { projectId: 1, agent: 1, createdAt: -1 }, name: 'byAgent' },
      // The periodic pass for questions nobody was told about asks across every
      // project at once, so it starts where the others cannot: at the status.
      // Not sparse: a question with no `notifiedAt` at all is exactly the one
      // it is looking for.
      { key: { status: 1, notifiedAt: 1, createdAt: 1 }, name: 'missed' },
      // Answered, newest first: the history on the project page and the recent
      // list on the operator's. Sorted by when the decision was made rather
      // than when the question was asked, which is the order those two read
      // and the one `inbox` cannot serve.
      { key: { projectId: 1, answeredAt: -1 }, name: 'answered' },
      // The inbox, which is the endpoint an agent polls on every iteration:
      // answers it has not acted on yet, newest first. Without the
      // acknowledgement in the key, a board whose answers have all been acted
      // on walks every one of them to return nothing, on every poll, for ever.
      { key: { projectId: 1, acknowledgedAt: 1, answeredAt: -1 }, name: 'unread' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.keys, [
      { key: { hash: 1 }, unique: true, name: 'hash' },
      { key: { projectId: 1 }, name: 'project' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.claimCodes, [
      { key: { projectId: 1 }, name: 'project' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.oauthClients, [
      { key: { projectId: 1 }, name: 'project' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.shares, [
      { key: { email: 1, createdAt: -1 }, name: 'inbox' },
      { key: { projectId: 1, email: 1 }, unique: true, name: 'once' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.handovers, [
      { key: { projectId: 1, createdAt: -1 }, name: 'project' },
      // One per address per project: asking twice is the same ask.
      { key: { projectId: 1, email: 1 }, unique: true, name: 'once' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.operatorTokens, [
      { key: { hash: 1 }, unique: true, name: 'hash' },
      { key: { email: 1 }, name: 'email' },
    ]),
    ensure(store.operatorSessions, [
      { key: { hash: 1 }, unique: true, name: 'hash' },
      { key: { email: 1 }, name: 'email' },
      // The session ends on its own even if nobody logs out.
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.operatorAliases, [{ key: { email: 1 }, unique: true, name: 'email' }]),
    ensure(store.events, [
      { key: { kind: 1, at: -1 }, name: 'kind' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.operatorCodes, [
      // Unique, so two overlapping requests for the same address cannot leave
      // two live codes behind and make the newer email the one that fails.
      { key: { email: 1 }, unique: true, name: 'email' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
  ]);
}
