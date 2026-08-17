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
  close(): Promise<void>;
}

export async function createStore(uri: string, dbName: string): Promise<Store> {
  const client = new MongoClient(uri, {
    // Agents call this in a loop; a request should fail fast rather than hang
    // on a wedged primary and burn the caller's own timeout budget.
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    maxPoolSize: 20,
  });
  await client.connect();
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
    close: () => client.close(),
  };

  await ensureIndexes(store);
  await runMigrations(store);
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
async function ensure(
  collection: { createIndexes: (specs: IndexDescription[]) => Promise<unknown>; dropIndex: (name: string) => Promise<unknown> },
  specs: IndexDescription[],
): Promise<void> {
  try {
    await collection.createIndexes(specs);
  } catch (error) {
    // 86 is IndexKeySpecsConflict: same name, different definition.
    if ((error as { code?: number }).code !== 86) throw error;
    for (const spec of specs) {
      if (!spec.name) continue;
      await collection.dropIndex(spec.name).catch(() => undefined);
    }
    await collection.createIndexes(specs);
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
      { key: { projectId: 1, updatedAt: -1 }, name: 'recent' },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
    ]),
    ensure(store.escalations, [
      { key: { projectId: 1, status: 1, createdAt: -1 }, name: 'inbox' },
      { key: { projectId: 1, status: 1, priorityRank: -1, createdAt: 1 }, name: 'queue' },
      { key: { projectId: 1, agent: 1, createdAt: -1 }, name: 'byAgent' },
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
