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
    priority_min?: number;
    fields?: Record<string, Array<string | number | boolean>>;
  };
}

export interface BoardConfig {
  rows: 'none' | 'owner' | 'label';
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
  /** Names left out for length. Zero on every project anybody actually has. */
  omitted: { owners: number; agents: number };
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
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'MusterError';
  }
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
    const body = (await response.json()) as CreatedProject & { error?: string; message?: string };
    if (!response.ok) {
      throw new MusterError(response.status, body.error ?? 'error', body.message ?? 'Failed', body);
    }
    return body;
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
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    // A contested claim is the one 409 that is an answer rather than a failure:
    // "somebody else is on it" is information the caller acts on. Every other
    // 409, a full project or a heartbeat from the wrong agent, is an error and
    // must not be handed back as if the write had happened.
    const isContestedClaim =
      response.status === 409 && body.ok === false && typeof body.held_by === 'string';

    if (!response.ok && !isContestedClaim) {
      throw new MusterError(
        response.status,
        String(body.error ?? 'error'),
        String(body.message ?? response.statusText),
        body,
      );
    }
    return body as T;
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
      stale?: boolean;
      limit?: number;
    } = {},
  ): Promise<{ items: Item[] }> {
    return this.request('GET', '/items', undefined, {
      status: query.status,
      owner: query.owner,
      label: query.label,
      source: query.source,
      stale: query.stale === undefined ? undefined : String(query.stale),
      limit: query.limit === undefined ? undefined : String(query.limit),
    });
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

  async next(agent = this.actor): Promise<NextResult> {
    return this.request('GET', '/next', undefined, { agent });
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

  // -------------------------------------------------------- escalations

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

  async inbox(agent = this.actor): Promise<{ answers: Escalation[] }> {
    return this.request('GET', '/inbox', undefined, { agent });
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

  async sweep(): Promise<{ swept: Record<string, number> }> {
    return this.request('POST', '/sweep');
  }

  /** Creates another key programmatically. Needs an admin token. */
  async createKey(input: { name?: string; role?: 'write' | 'admin' } = {}): Promise<{
    key: { id: string; name: string; role: string };
    token: string;
  }> {
    return this.request('POST', '/keys', input);
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
