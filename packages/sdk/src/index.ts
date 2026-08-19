/**
 * Typed client for Muster.
 *
 * Zero dependencies and one file: the whole point of Muster is that an agent
 * can use it with curl, so the SDK is a convenience, never a requirement. Every
 * method maps one to one onto an HTTP call documented at /skill.md.
 */

export type ItemStatus = 'open' | 'blocked' | 'done' | 'dropped';
export type EscalationStatus = 'open' | 'answered' | 'resolved' | 'wont_do' | 'in_progress';
export type EscalationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Item {
  slug: string;
  title: string;
  body: string;
  status: ItemStatus;
  owner: string | null;
  priority: number;
  labels: string[];
  source: string | null;
  fields: Record<string, unknown>;
  stale: boolean;
  /** Who touched it last, by handle. Null on an item nobody has written to yet. */
  last_actor: string | null;
  claim: { agent: string; expires_at: string; heartbeat_at: string } | null;
  absence: { count: number; since: string | null } | null;
  /**
   * The cards this one waits on, by slug. Absent when it waits on nothing.
   *
   * Data, not a status: the server never moves an item because of it. What it
   * does is keep the card out of what `next` offers and refuse a claim on it,
   * naming what is unfinished.
   */
  blocked_by?: string[];
  created_at: string;
  updated_at: string;
  touched_at: string;
  closed_at: string | null;
  timeline_count: number;
  timeline?: TimelineEntry[];
}

export interface TimelineEntry {
  at: string;
  by: string;
  kind: string;
  message: string;
}

export interface Escalation {
  id: string;
  agent: string;
  question: string;
  context: string;
  priority: EscalationPriority;
  status: EscalationStatus;
  answer: string | null;
  answered_at: string | null;
  item_slug: string | null;
  /** When an agent said it had acted on the answer, and what it did. */
  acted_at: string | null;
  acted_by: string | null;
  acted_note: string | null;
  /**
   * Set only when the agent that asked took the question back. A `wont_do`
   * with these filled in is not a person having dropped it.
   */
  withdrawn_at: string | null;
  withdrawn_by: string | null;
  withdrawn_reason: string | null;
  /**
   * When the human was told, which is a different question from whether they
   * have replied. Null on a claimed board means nothing has gone out about this
   * one yet: either it is younger than the periodic pass, or nothing is leaving
   * the building at all.
   */
  notified_at: string | null;
  created_at: string;
}

export interface HistoryEntry {
  at: string;
  by?: string;
  message: string;
}

export interface UpsertInput {
  slug: string;
  title?: string;
  body?: string;
  status?: ItemStatus;
  owner?: string | null;
  /** -10 to 10, higher is more urgent. 0 is ordinary work and the default. */
  priority?: number;
  labels?: string[];
  fields?: Record<string, unknown>;
  source?: string | null;
  note?: string;
  actor?: string;
  /**
   * Timeline entries carried over from another system, with their original
   * timestamps. Applied only when the item is created, so re-running a
   * migration cannot duplicate them. Needs an admin token.
   */
  history?: HistoryEntry[];
  /** The cards this one waits on, by slug. An empty array clears the list. */
  blocked_by?: string[];
}

export interface UpsertResult {
  item: Item;
  created: boolean;
  /** Duplicate titles and cross-scope writes are reported, never blocked. */
  warnings: string[];
}

export interface ClaimResult {
  ok: boolean;
  item?: Item;
  expires_at?: string;
  held_by?: string;
  hint?: string;
}

export interface NextResult {
  item: Item | null;
  reason: string;
}

export interface CreatedProject {
  project: string;
  name: string;
  description: string;
  token: string;
  api: string;
  read_url: string;
  board_url: string;
  expires_at: string | null;
}

/**
 * What moving an item into a column means. A column that declares nothing gets
 * a conservative reading of its own filter, so the ordinary board works without
 * anybody writing this twice.
 */
export interface BoardApply {
  status?: ItemStatus;
  add_labels?: string[];
  remove_labels?: string[];
  owner?: string | null;
  priority?: number;
  claim?: boolean;
  release?: boolean;
  /**
   * For a column that asks for work which is not stale. Nothing is set: any
   * write clears the flag, and a move is a write. It has a name so that such a
   * column counts as a destination rather than deriving an empty apply. Only
   * true: a move always touches, so the server refuses a false.
   */
  touch?: true;
}

/**
 * A board column: a name and a filter over what an item already is. There is
 * deliberately no way to express a new status here, which is what stops a board
 * layout from becoming a vocabulary every agent has to learn.
 */
export interface BoardColumn {
  key?: string;
  title: string;
  hint?: string;
  apply?: BoardApply;
  match: {
    status?: ItemStatus[];
    labels?: string[];
    not_labels?: string[];
    owner?: string[];
    claimed?: boolean;
    stale?: boolean;
    source?: string[];
    /** Slug starts with this: the column for one area of a board that names its cards `area:thing`. */
    slug_prefix?: string;
    priority_min?: number;
    fields?: Record<string, Array<string | number | boolean>>;
  };
}

export interface BoardConfig {
  /** `prefix` lanes by the namespace already in the slug. */
  rows: 'none' | 'owner' | 'label' | 'prefix';
  columns: BoardColumn[];
}

export interface BoardCell {
  key: string;
  title: string;
  hint?: string;
  count: number;
  truncated: boolean;
  items?: Item[];
}

export interface BoardView {
  board: BoardConfig;
  /** What the board was narrowed to. Empty when it is the whole board. */
  filter: { owner?: string; agent?: string };
  totals: Array<{ key: string; title: string; count: number }>;
  /** Items no column matched. A board that hides work is worse than no board. */
  unplaced: number;
  partial: boolean;
  rows: Array<{ key: string; title: string; columns: BoardCell[] }>;
}

export interface BoardFacets {
  /** Every name a board can be narrowed to with `owner=`. */
  owners: string[];
  /** Every name a board can be narrowed to with `agent=`. */
  agents: string[];
  /** What each agent said it is for. Only the ones that said something. */
  agentsDescribed: Array<{ handle: string; description: string; registered: boolean }>;
  /** Every label on this board's work, for `label=`. */
  labels: string[];
  /**
   * Every slug namespace on this board, for `prefix=`. Carries the delimiter,
   * because this is the value to pass back rather than the name to print: on a
   * board holding both `ops:` and `ops2:`, `ops` is two namespaces.
   */
  prefixes: string[];
  /** Names left out for length. Zero on every project anybody actually has. */
  omitted: { owners: number; agents: number; labels: number; prefixes: number };
}

export interface HygieneRules {
  /** Hours before untouched work is flagged stale. Null stops flagging it. */
  stale_after_hours?: number | null;
  /**
   * How an item stops being mentioned by the signal that files it. Both halves
   * are required together: consecutive absences and hours of wall clock, so a
   * single failed poll cannot close live work. Null stops closing anything.
   */
  absence_resolve?: { observations: number; min_hours: number } | null;
  /** Hours before a card with a title and no body is flagged. Null stops it. */
  require_body_after_hours?: number | null;
  /** Default lease length for a claim that does not name one. */
  claim_ttl_minutes?: number;
  /** Whether writing outside a registered handle's scope is warned about. */
  scope_warnings?: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Null for a key that does not expire. */
  expires_at: string | null;
}

export interface MusterOptions {
  project: string;
  token: string;
  baseUrl?: string;
  /** Sent as the actor on every write that does not name one. */
  actor?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_BASE_URL = 'https://musterboard.dev';

export class MusterError extends Error {
  /**
   * How long to wait, when the answer said to wait.
   *
   * The service publishes this twice on every answer that means later: as the
   * `retry-after` header, and as `retry_after` in the body. Until this field
   * existed it survived neither trip through here: nothing read a header, and
   * the body arrived as `unknown`, so a caller had to know the field name and
   * cast to reach it. The number is the difference between a loop that comes
   * back when it is welcome and one that hammers a door that already said when
   * to knock.
   */
  readonly retryAfterSeconds: number | null;

  /**
   * Whether coming back is the right move. True for a rate limit and for a
   * store out of reach, and for nothing else: this service separates 503,
   * which means come back, from 500, which means it is broken and a retry
   * changes nothing. Deliberately not acted on here. Retrying a write nobody
   * knows landed is how one board gets two of everything, so the SDK reports
   * and the caller decides.
   */
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'MusterError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.retryable = status === 429 || status === 503;
  }
}

/**
 * Tolerance belongs on the way out, not on the way in.
 *
 * An answer that says it worked has to be readable, or it is not the answer
 * the call promised. Handing back what could not be parsed would give the
 * caller an object with every field undefined and let it carry on as though
 * the write had been described back to it, which is worse than the parse error
 * it used to get. It still arrives as a MusterError rather than a SyntaxError,
 * so the status and the delay survive.
 */
function readable<T>(response: { status: number; headers: Headers }, text: string): T {
  try {
    // Nothing at all counts as unreadable, not as an empty object. Every 2xx
    // this service sends carries a body, down to `{"ok":true}` from a delete,
    // so an empty one is never this service answering. Handing back `{}` let
    // `start()` build a client with no project and no token and carry on, which
    // is the silent-invalid-result this whole function exists to refuse.
    if (!text) throw new SyntaxError('empty');
    return JSON.parse(text) as T;
  } catch {
    throw new MusterError(
      response.status,
      'unreadable_answer',
      text
        ? 'The answer said it worked and was not JSON. Something between you and the service rewrote it.'
        : 'The answer said it worked and was empty. Something between you and the service dropped it.',
      { body: text },
      retryAfterOf(response, {}),
    );
  }
}

function parsed(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : { body: value };
  } catch {
    return { body: text };
  }
}

/**
 * The header first, because it is where HTTP puts this and it survives an
 * answer that is not JSON at all, which is what a proxy in front of a service
 * having a bad minute tends to send.
 */
function retryAfterOf(response: { headers: Headers }, body: Record<string, unknown>): number | null {
  // Asking for the value before asking whether there is one: a missing header
  // reads as null, `Number(null)` is 0, and 0 seconds is "come back now",
  // which is the opposite of the nothing that was actually said.
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  const said = body.retry_after;
  return typeof said === 'number' && Number.isFinite(said) ? said : null;
}

export class Muster {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly project: string;
  readonly actor: string | undefined;

  constructor(private readonly options: MusterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.project = options.project;
    this.actor = options.actor;
  }

  /**
   * The whole signup: no account, no human. Keep the token it returns, it is
   * shown once.
   */
  static async createProject(
    input: { name?: string; description?: string; baseUrl?: string; fetch?: typeof fetch } = {},
  ): Promise<CreatedProject> {
    const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const doFetch = input.fetch ?? globalThis.fetch;
    const response = await doFetch(`${baseUrl}/p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, description: input.description }),
    });
    // Read once, as text, and decide after. Calling `.json()` here threw a
    // SyntaxError before any of the handling below on exactly the answer this
    // handling is for, and signup is the first call an agent ever makes: the
    // status, the code and the delay were lost together on the one request
    // there is no client yet to retry with.
    const text = await response.text();
    if (!response.ok) {
      const refused = parsed(text);
      throw new MusterError(
        response.status,
        String(refused.error ?? 'error'),
        String(refused.message ?? response.statusText ?? 'Failed'),
        refused,
        retryAfterOf(response, refused),
      );
    }
    return readable<CreatedProject>(response, text);
  }

  /** Convenience: create a project and return a client already pointed at it. */
  static async start(
    input: {
      name?: string;
      description?: string;
      actor?: string;
      baseUrl?: string;
      fetch?: typeof fetch;
    } = {},
  ): Promise<{ client: Muster; created: CreatedProject }> {
    const created = await Muster.createProject(input);
    return {
      created,
      client: new Muster({
        project: created.project,
        token: created.token,
        baseUrl: input.baseUrl,
        actor: input.actor,
        fetch: input.fetch,
      }),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    payload?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1/${this.project}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    const text = await response.text();

    if (!response.ok) {
      // Not every answer is this service's. A proxy in front of it having a
      // bad minute sends HTML or plain text, and parsing it threw a
      // SyntaxError from inside this method: the caller got a JSON complaint
      // instead of the 503 that had actually arrived, with the status, the
      // code and the delay all lost on the way. What cannot be read is kept
      // as text, so the error still carries what came back.
      const body = parsed(text);

      // A contested claim is the one 409 that is an answer rather than a
      // failure: "somebody else is on it" is information the caller acts on.
      // Every other 409, a full project or a heartbeat from the wrong agent,
      // is an error and must not be handed back as if the write had happened.
      const isContestedClaim = body.ok === false && typeof body.held_by === 'string';
      if (response.status === 409 && isContestedClaim) return body as T;

      throw new MusterError(
        response.status,
        String(body.error ?? 'error'),
        String(body.message ?? response.statusText),
        body,
        retryAfterOf(response, body),
      );
    }
    return readable<T>(response, text);
  }

  // ------------------------------------------------------------- agents

  async registerAgent(input: {
    handle: string;
    scope?: string[];
    description?: string;
    meta?: Record<string, unknown>;
  }): Promise<{ agent: { handle: string; scope: string[] }; created: boolean }> {
    return this.request('POST', '/agents', input);
  }

  async agents(): Promise<{ agents: Array<{ handle: string; scope: string[] }> }> {
    return this.request('GET', '/agents');
  }

  // -------------------------------------------------------------- items

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    return this.request('POST', '/items', { actor: this.actor, ...input });
  }

  async items(
    query: {
      status?: ItemStatus;
      owner?: string;
      label?: string;
      source?: string;
      /**
       * Slug starts with this. Anchored and indexed, unlike `q`, which is a
       * substring and scans, so this is the cheap way to read one area of a
       * board that names its cards `area:thing`.
       */
      prefix?: string;
      stale?: boolean;
      /** True for items somebody holds right now. An expired claim counts as free. */
      claimed?: boolean;
      /** Words to look for in the slug or the title, case insensitive. */
      q?: string;
      limit?: number;
      /**
       * `urgency` (default) is most urgent first. `id` is a stable order for
       * reading everything back: priority and updatedAt change while you page,
       * so an item that moves behind the cursor is one your export never saw.
       */
      order?: 'urgency' | 'id' | 'recent';
      /** From the previous page's `next_cursor`, in the same order. */
      cursor?: string;
      /**
       * Only what changed at or after this moment, as an ISO string. Pass back
       * the `as_of` from your previous read: your clock is not the one that
       * stamped these rows. Every page of one walk reports the same `as_of`,
       * so it does not matter which page you keep it from.
       */
      since?: string;
    } = {},
  ): Promise<{ items: Item[]; next_cursor: string | null; as_of: string }> {
    return this.request('GET', '/items', undefined, {
      status: query.status,
      owner: query.owner,
      label: query.label,
      source: query.source,
      prefix: query.prefix,
      stale: query.stale === undefined ? undefined : String(query.stale),
      claimed: query.claimed === undefined ? undefined : String(query.claimed),
      q: query.q,
      limit: query.limit === undefined ? undefined : String(query.limit),
      order: query.order,
      cursor: query.cursor,
      since: query.since,
    });
  }

  /**
   * Every item, in an order nothing reshuffles while you read. This is the call
   * for checking an import against its source, which is the only thing that can
   * tell you a migration worked.
   */
  async *allItems(query: { status?: ItemStatus; label?: string; source?: string; prefix?: string } = {}) {
    let cursor: string | undefined;
    do {
      const page = await this.items({ ...query, limit: 200, order: 'id', cursor });
      for (const item of page.items) yield item;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  async item(slug: string): Promise<{ item: Item }> {
    return this.request('GET', `/items/${encodeURIComponent(slug)}`);
  }

  async note(slug: string, message: string, actor = this.actor): Promise<{ item: Item }> {
    return this.request('POST', `/items/${encodeURIComponent(slug)}/timeline`, { message, actor });
  }

  /**
   * Removes an item and its history. Closing is the normal ending and keeps the
   * record; this is for mistakes and bad imports. Needs an admin token.
   */
  async deleteItem(slug: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/items/${encodeURIComponent(slug)}`);
  }

  /**
   * What to pick up next, without taking it. Safe to poll and safe for a proxy
   * or a client to retry, because it writes nothing.
   */
  async next(agent = this.actor): Promise<NextResult> {
    return this.request('GET', '/next', undefined, { agent });
  }

  /**
   * The same choice, taken in the same breath.
   *
   * A fleet that looks and then claims is a fleet where everybody is offered
   * the same card and one of them wins: nine loops out of ten spend a round
   * trip losing a race. The service settles that in one update, and until this
   * existed nothing here could reach it, so every fleet built on this package
   * had the problem the endpoint was written to remove.
   *
   * `claimed` says whether the lease came with the card. A null item means
   * there was nothing to take, which is not a failure.
   */
  async take(
    agent = this.actor,
    ttlMinutes?: number,
  ): Promise<NextResult & { claimed: boolean }> {
    return this.request('POST', '/next', {
      agent,
      ...(ttlMinutes === undefined ? {} : { ttl_minutes: ttlMinutes }),
    });
  }

  async observe(
    source: string,
    present: string[],
  ): Promise<{ present: number; absent: number; resolved: number }> {
    return this.request('POST', '/observe', { source, present });
  }

  // ------------------------------------------------------------- claims

  async claim(slug: string, agent = this.actor, ttlMinutes?: number): Promise<ClaimResult> {
    return this.request('POST', `/items/${encodeURIComponent(slug)}/claim`, {
      agent,
      ttl_minutes: ttlMinutes,
    });
  }

  async heartbeat(slug: string, agent = this.actor, ttlMinutes?: number): Promise<{ ok: boolean }> {
    return this.request('POST', `/items/${encodeURIComponent(slug)}/heartbeat`, {
      agent,
      ttl_minutes: ttlMinutes,
    });
  }

  async release(slug: string, agent = this.actor, note?: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/items/${encodeURIComponent(slug)}/release`, { agent, note });
  }

  /**
   * Claims an item, keeps the lease alive while `work` runs, and releases it
   * afterwards even if the work throws. Returns null without running anything
   * when another agent holds the claim, which is the answer you want: do
   * something else rather than duplicate their work.
   */
  async withClaim<T>(
    slug: string,
    work: (item: Item) => Promise<T>,
    options: { agent?: string; ttlMinutes?: number } = {},
  ): Promise<T | null> {
    const agent = options.agent ?? this.actor;
    const ttlMinutes = options.ttlMinutes ?? 15;
    const claimed = await this.claim(slug, agent, ttlMinutes);
    if (!claimed.ok || !claimed.item) return null;

    const beat = setInterval(() => {
      void this.heartbeat(slug, agent, ttlMinutes).catch(() => undefined);
    }, Math.max(30_000, (ttlMinutes * 60_000) / 3));
    if (typeof beat.unref === 'function') beat.unref();

    try {
      return await work(claimed.item);
    } finally {
      clearInterval(beat);
      await this.release(slug, agent).catch(() => undefined);
    }
  }

  /**
   * The loop, for anything running more than one of these.
   *
   * `next()` and then `withClaim()` reads well and is a race: everybody is
   * offered the same card and one of them wins the claim that follows. This
   * takes the card and the lease in a single write, keeps the lease alive while
   * the work runs, and hands it back afterwards even if the work throws.
   *
   * Returns null when there was nothing to take, which is the ordinary answer
   * on a quiet board and not a failure.
   */
  async withNext<T>(
    work: (item: Item) => Promise<T>,
    options: { agent?: string; ttlMinutes?: number } = {},
  ): Promise<T | null> {
    const agent = options.agent ?? this.actor;
    const ttlMinutes = options.ttlMinutes ?? 15;
    const taken = await this.take(agent, ttlMinutes);
    if (!taken.item || !taken.claimed) return null;
    const slug = taken.item.slug;

    const beat = setInterval(() => {
      void this.heartbeat(slug, agent, ttlMinutes).catch(() => undefined);
    }, Math.max(30_000, (ttlMinutes * 60_000) / 3));
    if (typeof beat.unref === 'function') beat.unref();

    try {
      return await work(taken.item);
    } finally {
      clearInterval(beat);
      await this.release(slug, agent).catch(() => undefined);
    }
  }

  // -------------------------------------------------------- escalations

  /**
   * Say you have acted on an answer. Not one of the four statuses: those are
   * the human's decision, this is what happened next. It is what keeps your
   * next iteration from doing the work twice, and the only way the person who
   * answered learns that their answer went anywhere.
   */
  async acknowledge(
    id: string,
    input: { note?: string; agent?: string } = {},
  ): Promise<{ escalation: Escalation }> {
    return this.request('POST', `/escalations/${encodeURIComponent(id)}/ack`, {
      agent: input.agent ?? this.actor,
      note: input.note,
    });
  }

  /**
   * Takes back a question you should not have asked.
   *
   * The mirror of {@link acknowledge}: that one is refused while nobody has
   * answered, this one the moment somebody has, because taking back an
   * answered question throws away attention a person already spent. Doing it
   * before the service has mailed the operator stops the message going out at
   * all, which is the only moment anybody can. The reason is required and is
   * what the operator reads if the mail already went.
   */
  async withdraw(
    id: string,
    reason: string,
    agent = this.actor,
  ): Promise<{ escalation: Escalation }> {
    return this.request('POST', `/escalations/${encodeURIComponent(id)}/withdraw`, {
      agent,
      reason,
    });
  }

  async escalate(input: {
    question: string;
    context?: string;
    priority?: EscalationPriority;
    itemSlug?: string;
    agent?: string;
  }): Promise<{ escalation: Escalation; read_url: string }> {
    return this.request('POST', '/escalations', {
      question: input.question,
      context: input.context,
      priority: input.priority,
      item_slug: input.itemSlug ?? null,
      agent: input.agent ?? this.actor,
    });
  }

  /**
   * Answers waiting for you. Ones you have already acted on are left out, so
   * an iteration that reads this does not repeat yesterday's work.
   *
   * `waiting` is your own questions that nobody has answered yet. Without it an
   * empty inbox means two different things, "the human has not got to it" and
   * "the question was never filed", and only one of those is worth asking
   * again.
   */
  async inbox(
    agent = this.actor,
    includeActed = false,
  ): Promise<{
    answers: Escalation[];
    waiting: Escalation[];
    /**
     * People who asked to be made the owner of this project, if it has none.
     * Answer one by calling `share` with that address; never send anybody the
     * project token.
     */
    handover_requests?: Array<{ email: string; note: string; asked_at: string }>;
    hint?: string;
  }> {
    return this.request('GET', '/inbox', undefined, {
      agent,
      ...(includeActed ? { include_acted: 'true' } : {}),
    });
  }

  async escalations(
    query: { status?: EscalationStatus; agent?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ escalations: Escalation[]; next_cursor: string | null }> {
    return this.request('GET', '/escalations', undefined, {
      status: query.status,
      agent: query.agent,
      limit: query.limit === undefined ? undefined : String(query.limit),
      cursor: query.cursor,
    });
  }

  /** Walks every page, for a caller that wants the whole history at once. */
  async allEscalations(
    query: { status?: EscalationStatus; agent?: string } = {},
  ): Promise<Escalation[]> {
    const all: Escalation[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.escalations({ ...query, limit: 200, cursor });
      all.push(...page.escalations);
      if (page.escalations.length < 200 || !page.next_cursor) return all;
      cursor = page.next_cursor;
    }
  }

  /**
   * Answers a question on the operator's behalf: the same four meanings the web
   * view offers. Needs an admin token.
   */
  async answer(
    id: string,
    status: Exclude<EscalationStatus, 'open'> | 'open',
    answer = '',
  ): Promise<{ escalation: Escalation }> {
    return this.request('PATCH', `/escalations/${encodeURIComponent(id)}`, { status, answer });
  }

  // -------------------------------------------------------------- board

  /**
   * The project's columns as its operator laid them out. Worth reading once
   * when you join a project: a column is a filter over status, labels, owner
   * and claim state, so the board tells you how this project wants work
   * described. It never introduces a fifth status.
   */
  async board(
    options: { items?: boolean; includeClosed?: boolean; owner?: string; agent?: string } = {},
  ): Promise<BoardView> {
    return this.request('GET', '/board', undefined, {
      items: options.items === undefined ? undefined : String(options.items),
      include_closed: options.includeClosed === undefined ? undefined : String(options.includeClosed),
      owner: options.owner,
      agent: options.agent,
    });
  }

  /**
   * The owners and agents this board can be narrowed to: every agent registered
   * in the project, whether or not it has written anything yet, plus the names
   * read off the items.
   *
   * Both lists are plain strings, because those are the values that go back in
   * as `owner=` and `agent=`. What each agent is for is a separate field, and
   * `omitted` counts the names left out on a project too large to list.
   */
  async boardFacets(): Promise<BoardFacets> {
    return this.request('GET', '/board/facets');
  }

  /** Lays the board out. Needs an admin token. */
  async setBoard(config: BoardConfig): Promise<{ board: BoardConfig }> {
    return this.request('PUT', '/board', config);
  }

  async boardPresets(): Promise<{
    presets: Array<{ key: string; title: string; description: string; board: BoardConfig }>;
  }> {
    return this.request('GET', '/board/presets');
  }

  /**
   * Moves an item into a column, doing whatever that column declares belongs
   * there. `landed_in` is where the item actually is afterwards: a column can
   * filter on more than a move can set, and it is worth checking rather than
   * assuming the card went where you sent it.
   */
  async move(
    slug: string,
    column: string,
    options: { note?: string; actor?: string } = {},
  ): Promise<{ ok: boolean; item: Item; applied: BoardApply; landed_in: string | null; warning?: string }> {
    return this.request('POST', `/items/${encodeURIComponent(slug)}/move`, {
      column,
      note: options.note,
      actor: options.actor ?? this.actor,
    });
  }

  // ------------------------------------------------------------ project

  async summary(): Promise<Record<string, unknown>> {
    return this.request('GET', '');
  }

  /** Renames the board or says what it is for. Needs an admin token. */
  async describe(input: { name?: string; description?: string }): Promise<Record<string, unknown>> {
    return this.request('PATCH', '', input);
  }

  /**
   * Offers this board to a person. It waits in their operator view until they
   * accept, which makes them the owner, lifts the limits and stops the project
   * expiring. Send them `tell_them` either way: the answer is deliberately the
   * same whether or not that address already uses Muster, because whether it
   * does is not the caller's business.
   */
  async share(input: { email: string; note?: string; agent?: string }): Promise<{
    ok: boolean;
    pending?: boolean;
    already_owned?: boolean;
    tell_them?: string;
    hint?: string;
  }> {
    return this.request('POST', '/share', {
      email: input.email,
      note: input.note,
      agent: input.agent ?? this.actor,
    });
  }

  /**
   * Runs the hygiene rules now. `swept` counts what each rule acted on;
   * `unmarked` appears only when a rule took a flag back *off* something,
   * which is rare enough that reporting it as a zero every time would be
   * noise.
   */
  async sweep(): Promise<{ swept: Record<string, number>; unmarked?: Record<string, number> }> {
    return this.request('POST', '/sweep');
  }

  /** Creates another key programmatically. Needs an admin token. */
  async createKey(input: { name?: string; role?: 'write' | 'admin' } = {}): Promise<{
    key: { id: string; name: string; role: string };
    token: string;
  }> {
    return this.request('POST', '/keys', input);
  }

  /**
   * Every key this project has, without the tokens: those are shown once.
   * Revoked ones stay on the list with a date, because a list of live keys
   * cannot answer what happened to one that used to work.
   */
  async keys(): Promise<{ keys: ApiKey[] }> {
    return this.request('GET', '/keys');
  }

  /**
   * Revokes one. Minting a credential from code and having to open a browser
   * to take it back is the kind of asymmetry that leaves keys alive forever.
   */
  async deleteKey(id: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/keys/${encodeURIComponent(id)}`);
  }

  /**
   * Moves everything one handle wrote, and any lease it holds, onto another.
   * What an agent does after it notices it has been calling itself two things.
   */
  async renameAgent(from: string, to: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/agents/${encodeURIComponent(from)}/rename`, { to });
  }

  /**
   * The hygiene rules this project runs itself by.
   *
   * Read out of the published schema and not from the field names, which is
   * how the first version of this got `absence_resolve` wrong: it is two
   * numbers and not one, because closing work an external signal stopped
   * mentioning needs both a count of consecutive absences and hours of wall
   * clock, and one failed poll must not close live work. Null turns a rule
   * off, which is why three of these take it.
   */
  async setRules(input: HygieneRules): Promise<Record<string, unknown>> {
    return this.request('PATCH', '/rules', input);
  }

  /**
   * A new read link, and the old one stops working. What to do from code the
   * moment a link that was meant for one person turns up somewhere else.
   */
  async rotateReadLink(): Promise<{ read_url: string }> {
    return this.request('POST', '/read-link/rotate');
  }

  /** Starts the human claim by emailing a six digit code. */
  async claimProject(email: string): Promise<{ ok: boolean; delivery: string }> {
    return this.request('POST', '/claim', { email });
  }

  async verifyClaim(email: string, code: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/claim/verify', { email, code });
  }
}

export default Muster;
