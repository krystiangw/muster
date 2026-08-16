/**
 * Domain types.
 *
 * The status enum is deliberately tiny. The audit that led to this project
 * found the opposite on a real board: eleven
 * statuses, nine owner lanes and four action classes, whose enum copies drifted
 * twice and left 63 tickets unroutable. Anything richer than these four values
 * belongs in `fields`, where it cannot break routing.
 *
 * "In progress" is not a status. An item is being worked on when it has a live
 * claim, which is a single source of truth for ownership and cannot desync from
 * a status field somebody forgot to flip.
 */
export type ItemStatus = 'open' | 'blocked' | 'done' | 'dropped';

export const ITEM_STATUSES: readonly ItemStatus[] = ['open', 'blocked', 'done', 'dropped'];

export const TERMINAL_STATUSES: readonly ItemStatus[] = ['done', 'dropped'];

/** Answer semantics lifted from operator-inbox-app, which got them right. */
export type EscalationStatus = 'open' | 'answered' | 'resolved' | 'wont_do' | 'in_progress';

export const ESCALATION_STATUSES: readonly EscalationStatus[] = [
  'open',
  'answered',
  'resolved',
  'wont_do',
  'in_progress',
];

export type EscalationPriority = 'low' | 'normal' | 'high' | 'urgent';

export const ESCALATION_PRIORITIES: readonly EscalationPriority[] = [
  'low',
  'normal',
  'high',
  'urgent',
];

export type TimelineKind =
  | 'created'
  | 'updated'
  | 'claimed'
  | 'released'
  | 'note'
  | 'status'
  | 'hygiene'
  | 'escalated';

export interface TimelineEntry {
  at: Date;
  by: string;
  kind: TimelineKind;
  message: string;
}

export interface Claim {
  agent: string;
  claimedAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
}

export interface Absence {
  count: number;
  since: Date | null;
}

export interface ItemDoc {
  _id: string;
  projectId: string;
  /** Stable, caller-chosen key. Unique per project. This is the idempotency key. */
  slug: string;
  title: string;
  /** Normalised title words, used only for the soft duplicate hint. */
  titleKey: string;
  body: string;
  owner: string | null;
  status: ItemStatus;
  priority: number;
  /** Set when the item mirrors an external signal, so absence rules can apply. */
  source: string | null;
  labels: string[];
  fields: Record<string, unknown>;
  claim: Claim | null;
  timeline: TimelineEntry[];
  timelineCount: number;
  absence: Absence;
  stale: boolean;
  staleSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Last write by an agent or human. Hygiene writes deliberately do not move it. */
  touchedAt: Date;
  closedAt: Date | null;
}

export interface AgentDoc {
  _id: string;
  projectId: string;
  handle: string;
  /** Free-form scope tokens: domains, path globs, subsystem names. Advisory only. */
  scope: string[];
  description: string;
  registeredAt: Date;
  lastSeenAt: Date;
  meta: Record<string, unknown>;
}

export interface EscalationDoc {
  _id: string;
  projectId: string;
  agent: string;
  question: string;
  context: string;
  priority: EscalationPriority;
  status: EscalationStatus;
  answer: string | null;
  answeredAt: Date | null;
  itemSlug: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Hygiene rules. Every field is a number or null, so a project can be tuned
 * without a deploy and a rule can be turned off by setting it to null.
 */
export interface HygieneRules {
  /** Mark an untouched, non-terminal item stale after this many hours. null disables. */
  staleAfterHours: number | null;
  /**
   * Close an item whose source signal has been absent for `observations`
   * consecutive observation rounds AND at least `minHours` of wall clock.
   * Both guards are required: the board this replaced learned the hard way that either one alone
   * closes live tickets during a sync blip.
   */
  absenceResolve: { observations: number; minHours: number } | null;
  /** Drop items that never got a title or body within this many hours. null disables. */
  requireBodyAfterHours: number | null;
  /** How long a claim survives without a heartbeat. */
  claimTtlMinutes: number;
  /** Warn when an agent writes outside its declared scope. Never blocks. */
  scopeWarnings: boolean;
}

export const DEFAULT_RULES: HygieneRules = {
  staleAfterHours: 72,
  absenceResolve: { observations: 2, minHours: 24 },
  requireBodyAfterHours: 24,
  claimTtlMinutes: 60,
  scopeWarnings: true,
};

export type ProjectTier = 'demo' | 'free' | 'pro';

export interface ProjectLimits {
  items: number;
  agents: number;
  escalations: number;
}

export interface ProjectDoc {
  _id: string;
  name: string;
  tier: ProjectTier;
  limits: ProjectLimits;
  rules: HygieneRules;
  readToken: string;
  claimedBy: string | null;
  claimedAt: Date | null;
  /** Unclaimed demo projects are swept by a TTL index. Null once claimed. */
  expiresAt: Date | null;
  createdAt: Date;
  lastSweptAt: Date | null;
  counts: { items: number; agents: number; escalations: number };
}

export type ApiKeyRole = 'write' | 'admin';

export interface ApiKeyDoc {
  _id: string;
  projectId: string;
  /** sha256 of the presented token. The token itself is never stored. */
  hash: string;
  name: string;
  role: ApiKeyRole;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** A pending email claim of a demo project. */
export interface ClaimCodeDoc {
  _id: string;
  projectId: string;
  email: string;
  codeHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
}
