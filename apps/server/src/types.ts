/**
 * Domain types.
 *
 * The status enum is deliberately tiny. The audit that led to this project
 * found the opposite on a real board: eleven statuses, nine owner lanes and
 * four action classes, whose enum copies drifted twice and left 63 tickets
 * unroutable. Anything richer than these four values
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

/**
 * Sorting by the word puts "high" below "low" and "normal", because that is
 * alphabetical order and a database has no idea what these words mean. The rank
 * is stored alongside the word so the operator's queue is ordered by urgency.
 */
export const PRIORITY_RANK: Record<EscalationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

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
  /**
   * Who touched this last, by handle. A board where six agents work looks like
   * one anonymous queue without it: the claim says who holds an item right now,
   * and this says who moved the ones nobody is holding. Hygiene never sets it,
   * because a sweep is not somebody working.
   */
  lastActor: string | null;
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
  /** Numeric form of `priority`, so the queue can be sorted by urgency. */
  priorityRank: number;
  status: EscalationStatus;
  answer: string | null;
  answeredAt: Date | null;
  itemSlug: string | null;
  /**
   * When an agent said it had acted on the answer, and what it did.
   *
   * A separate axis from the four statuses on purpose: those are the human's
   * decision, and this is what happened next. Without it an answered question
   * looks identical before and after the work, so the next session cannot tell
   * whether to act, and the person who answered never learns that it landed.
   */
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  acknowledgedNote: string | null;
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
   * Both guards are required: the board this one replaces learned the hard way
   * that either one alone closes live tickets during a sync blip.
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

/**
 * Board layout.
 *
 * A column is a view, never a state. The four statuses stay four; a column is a
 * name and a filter over what an item already is, so a project can lay its board
 * out however it likes without adding a status that routing, hygiene and every
 * agent would then have to learn. That separation is the whole reason the enum
 * cannot drift: there is nothing to drift into.
 *
 * An item lands in the first column whose filter matches, so the board is a
 * partition and no card appears twice.
 */
export interface BoardMatch {
  /** Any of these statuses. Empty or absent means any status. */
  status?: ItemStatus[];
  /** Item carries at least one of these labels. */
  labels?: string[];
  /** Item carries none of these labels. */
  notLabels?: string[];
  owner?: string[];
  /** true: only claimed items. false: only unclaimed ones. */
  claimed?: boolean;
  stale?: boolean;
  source?: string[];
  priorityMin?: number;
  /** Values of `fields`, for boards migrated from a richer schema. */
  fields?: Record<string, Array<string | number | boolean>>;
}

/**
 * What moving an item into a column means.
 *
 * Without this a board is read-only for agents: they can see a column called
 * Monitoring but have to guess that it means adding a label. Declaring it once,
 * in the layout, turns the columns into a vocabulary both sides share. It can
 * only set things an item already has, so a column still cannot invent a state.
 */
export interface BoardApply {
  status?: ItemStatus;
  addLabels?: string[];
  removeLabels?: string[];
  owner?: string | null;
  priority?: number;
  /** Claims the item for whoever moved it, for a column that means "mine now". */
  claim?: boolean;
  /** Releases the claim, for a column that means "back in the pool". */
  release?: boolean;
}

export interface BoardColumn {
  key: string;
  title: string;
  match: BoardMatch;
  /** Shown under the title. Useful for saying what belongs here and what does not. */
  hint?: string;
  /** Applied by POST /items/{slug}/move. Derived from `match` when absent. */
  apply?: BoardApply;
}

export interface BoardConfig {
  columns: BoardColumn[];
  /** Swimlanes. `none` is one lane; `owner` groups by owner; `label` by the labels present. */
  rows: 'none' | 'owner' | 'label';
}

export const MAX_BOARD_COLUMNS = 12;

/**
 * What a project starts with. It mirrors the four statuses plus the one
 * distinction the statuses deliberately do not carry: whether somebody is
 * holding the item right now.
 */
export const DEFAULT_BOARD: BoardConfig = {
  rows: 'none',
  columns: [
    {
      key: 'todo',
      title: 'To do',
      hint: 'open, nobody on it',
      match: { status: ['open'], claimed: false },
    },
    {
      key: 'doing',
      title: 'In progress',
      hint: 'someone holds a live claim',
      match: { status: ['open'], claimed: true },
    },
    { key: 'blocked', title: 'Blocked', match: { status: ['blocked'] } },
    { key: 'done', title: 'Done', match: { status: ['done'] } },
  ],
};

/**
 * Who may open the read link.
 *
 * `link` is the default and has to be: an agent creates a project before any
 * person is involved, and the whole handover depends on being able to send
 * somebody a URL that just works. Once a person owns the project they can
 * narrow it to themselves, after which the link alone is not enough and the
 * reader has to be signed in as the owner.
 */
export type ProjectVisibility = 'link' | 'owner';

export type ProjectTier = 'demo' | 'free' | 'pro';

export interface ProjectLimits {
  items: number;
  agents: number;
  escalations: number;
}

export interface ProjectDoc {
  _id: string;
  name: string;
  /**
   * What this board is for, in the words of whoever created it. An operator
   * running nine of them needs to tell them apart at a glance, and an agent
   * arriving at one needs to know what belongs on it.
   */
  description: string;
  tier: ProjectTier;
  limits: ProjectLimits;
  rules: HygieneRules;
  /** Absent on projects created before boards existed; DEFAULT_BOARD applies. */
  board?: BoardConfig;
  readToken: string;
  /** Absent on projects created before this existed; `link` applies. */
  visibility?: ProjectVisibility;
  /**
   * When the project first received an item. Absent means never, which is what
   * makes the activation moment countable exactly once: the open item counter
   * cannot do it, because a first item created as `done` leaves it at zero and
   * every later write then looks like the first.
   */
  firstWriteAt?: Date;
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

/**
 * An agent offering a project to an operator.
 *
 * The operator owns every board in their inbox, but the agent is usually the
 * one that creates them, and making a person confirm an emailed code once per
 * project does not scale past about two. A share is an offer: it appears in the
 * operator's view, and one click accepts it. Nothing reaches their queue until
 * they say so, which is what keeps this from being a way to post junk into
 * somebody's inbox.
 */
export interface ShareDoc {
  _id: string;
  projectId: string;
  email: string;
  offeredBy: string;
  note: string;
  createdAt: Date;
  expiresAt: Date;
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
