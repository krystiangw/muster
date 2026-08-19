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
/**
 * The name a person's own writes carry.
 *
 * Not an agent and not a handle somebody forgot to register: it is the door.
 * Everything written through the read link or the operator's own page is signed
 * with it, so a timeline can say a human did this and a filter can show what
 * they touched. Every list of agents that offers it has to say which of those
 * two it is, or the next person to read one tries to consolidate the operator
 * into a loop.
 */
export const OPERATOR_ACTOR = 'operator';

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
  /**
   * Which lease this is, as opposed to when it ends.
   *
   * The one thing that can name a lease without ambiguity. A rollback that
   * matches on the holder can delete a newer lease the same agent took a
   * moment later, and one that matches on the expiry can still hit it: two
   * requests that renew in the same millisecond compute the same date. Only
   * the writer that put this value there may take it away.
   *
   * Absent on leases taken before it existed, which the rollback treats as a
   * lease it cannot claim to have written.
   */
  nonce?: string;
}

export interface Absence {
  count: number;
  since: Date | null;
}

/** The card an item files when it reaches a terminal status. */
export interface ItemSuccessor {
  slug: string;
  title?: string;
  body?: string;
  priority?: number;
  labels?: string[];
  owner?: string | null;
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
  /**
   * What to file when this one is finished.
   *
   * A pipeline written on the work itself rather than in an orchestrator
   * nobody here runs: the item that finishes files the next one, under a slug,
   * so re-finishing it writes the same card instead of a second copy.
   */
  then?: ItemSuccessor | null;
  /**
   * The cards this one is waiting on, by slug.
   *
   * Data, and deliberately nothing more. The engine never sets it, never
   * clears it, and never moves a status because of it: `blocked` is published
   * as the queue for work waiting on a person, and an engine writing it for a
   * dependency two agents can resolve between themselves would put work no
   * human can act on into a human's list. What this field does is refuse a
   * claim and get skipped by the offer, both of which an agent reads and can
   * fix in one write.
   *
   * A blocker nobody has filed yet blocks, and the refusal says so rather than
   * pretending the name is finished: "waiting on a card that is not on this
   * board" is a thing an agent can act on, and silently ignoring a typo is not.
   */
  blockedBy?: string[];
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
  /**
   * Names this agent used to write under, before somebody consolidated them.
   *
   * Kept because the timelines still carry them: renaming moves the state, the
   * live claim and whose work an item is, and leaves the history saying what it
   * said. A reader who meets `trades_loop` in an entry from March needs
   * somewhere to find out it is this one.
   */
  aliases?: string[];
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
   * When a message about this question left the building, if one ever did.
   *
   * The immediate notice is throttled to one per project per hour, which is
   * right for a burst and wrong for the question that arrives inside somebody
   * else's hour: without this it would be swallowed and the only trace of it
   * would be a page nobody has open. Null means nobody has been told yet, and
   * something periodic will.
   */
  notifiedAt?: Date | null;
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
  /**
   * Slug starts with this. The same shape `scope` matches on, so a column and
   * an agent's declared area are written the same way and mean the same thing.
   */
  slugPrefix?: string;
  priorityMin?: number;
  /**
   * Only work touched in the last N days.
   *
   * For the column that grows for ever. Finished work is still work: it is what
   * an agent reads to find out whether something was already tried, so it is
   * neither deleted nor given a fifth status nobody asked for. A column is a
   * view, and "what got done lately" is a view. Everything older stays in the
   * project, one search away, and this is the one filter that makes a Done
   * column stop being a landfill.
   */
  withinDays?: number;
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
  /**
   * The move is the write, and the write is the point.
   *
   * For a column that asks for work that is not stale. Nothing has to be set:
   * any write by an agent clears the flag, and a move is a write. Without a
   * name for it, a column whose only filter is `"stale": false` derives an
   * empty apply and the board decides it is not a destination, which leaves an
   * ordinary column unreachable for a reason nobody can see.
   *
   * Only ever true. There is no move that does not touch, so a false here
   * would be a column claiming a write it cannot withhold.
   */
  touch?: true;
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
  /**
   * Swimlanes. `none` is one lane; `owner` groups by owner; `label` by the
   * labels present; `prefix` by the namespace already in the slug.
   */
  rows: 'none' | 'owner' | 'label' | 'prefix';
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

/** One reading of a counter against the work it is supposed to count. */
export interface CounterObservation {
  open: number;
  counter: number;
  version: number;
  at: Date;
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
  /**
   * When this project last mailed its operator that an agent is waiting. The
   * stamp is the throttle, so it lives next to the project rather than in a
   * process that a restart would forget.
   */
  escalationNotifiedAt?: Date | null;
  /**
   * When a notice about this project last actually left.
   *
   * Deliberately not `escalationNotifiedAt`, which is the throttle claim: that
   * one is written before the send, atomically, so that two agents filing in
   * the same second cannot both mail. It moves whether or not the message ever
   * reached anybody, which makes it the wrong thing to publish as health.
   */
  escalationNoticeSentAt?: Date | null;
  /**
   * When this project last told its operator that nothing was moving.
   *
   * One per quiet spell rather than one per period: the pass sends only when
   * the board has been written to since this stamp, so a board that is quiet
   * for a month produces one message and a board that wakes up and stops again
   * produces a second. A notice that repeats on a timer is a notice people
   * filter, and this one is about the absence of events, which does not become
   * more true by being said twice.
   */
  quietNotifiedAt?: Date | null;
  /**
   * When the quiet-board pass last looked at this project, whether or not it
   * had anything to say.
   *
   * Kept apart from the stamp above, and it is what stops the pass starving.
   * Ordered by the notice date alone, twenty busy boards that have never been
   * told anything sit at the front of every pass for ever and nothing behind
   * them is ever examined. Ordered by when each was last looked at, the queue
   * turns over.
   */
  quietCheckedAt?: Date | null;
  /** Unclaimed demo projects are swept by a TTL index. Null once claimed. */
  expiresAt: Date | null;
  createdAt: Date;
  /**
   * The throttle claim, taken before a sweep runs, which is what keeps a burst
   * of agents from sweeping twenty times. It advances whether or not the pass
   * that took it finished.
   */
  /**
   * Bumped by every write that moves a counter, so the overcount repair can
   * ask whether anything happened rather than whether the numbers look the
   * same. Two closes reaching the same halfway state read identically; they
   * cannot have the same version.
   */
  countsVersion?: { items?: number; escalations?: number };
  /**
   * What the overcount repair last saw, per counter, so it can tell a leak
   * from a write in flight. A repair applies only when a later sweep finds the
   * same counter at the same version, half a minute on. Kept apart per counter
   * because a project whose items move all day would otherwise never settle
   * long enough to repair a stuck question count.
   */
  countsCheck?: {
    items?: CounterObservation;
    escalations?: CounterObservation;
  } | null;
  lastSweptAt: Date | null;
  /**
   * The throttle for the lease-only pass a read is allowed to run. Kept apart
   * from `lastSweptAt` on purpose: sharing one stamp would let a read take the
   * slot and do a tenth of the work, and the write a second later would find
   * the sweep already claimed and skip the rules it was the only trigger for.
   */
  leasesSweptAt?: Date | null;
  /**
   * When a sweep last finished. Written after the rules have run, so it is the
   * one date that tells a board with nothing to tidy apart from a sweeper that
   * throws on every pass.
   */
  sweptAt?: Date | null;
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
  /**
   * Whether this key's `expiresAt` is its own lifetime rather than the
   * project's. Claiming a project clears the expiry off everything that only
   * expired because the project did; a one hour access token is not that.
   */
  ownExpiry?: boolean;
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
  /**
   * When the offer actually reached the address, if it ever did.
   *
   * Recorded because "we wrote it down" and "somebody was told" are different
   * facts, and an agent deciding whether to offer the board again needs the
   * second one. A provider having a bad minute, or a deployment with no mail
   * configured at all, leaves a stored offer nobody has seen, and reading that
   * as "an offer is out" tells the agents to stop trying.
   */
  notifiedAt: Date | null;
}

/**
 * A person asking the agents to hand a project over.
 *
 * The mirror of a share, and deliberately not its equal: a share is an offer
 * the project makes and a person accepts, this is a request a person makes and
 * the project grants by making that offer. Only the project can move
 * ownership, because ownership has no way back: nothing in this service ever
 * sets `claimedBy` to null again, and the owner can mint an admin key at will.
 * So the read link is enough to ask, and never enough to take.
 */
export interface HandoverRequestDoc {
  _id: string;
  projectId: string;
  /** Taken from the signed in session, so the address is proven, not typed. */
  email: string;
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
