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

export interface UpsertInput {
  slug: string;
  title?: string;
  body?: string;
  status?: ItemStatus;
  owner?: string | null;
  priority?: number;
  labels?: string[];
  fields?: Record<string, unknown>;
  source?: string | null;
  note?: string;
  actor?: string;
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
  token: string;
  api: string;
  read_url: string;
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

export const DEFAULT_BASE_URL = 'https://muster.dev';

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
    input: { name?: string; baseUrl?: string; fetch?: typeof fetch } = {},
  ): Promise<CreatedProject> {
    const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const doFetch = input.fetch ?? globalThis.fetch;
    const response = await doFetch(`${baseUrl}/p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name }),
    });
    const body = (await response.json()) as CreatedProject & { error?: string; message?: string };
    if (!response.ok) {
      throw new MusterError(response.status, body.error ?? 'error', body.message ?? 'Failed', body);
    }
    return body;
  }

  /** Convenience: create a project and return a client already pointed at it. */
  static async start(
    input: { name?: string; actor?: string; baseUrl?: string; fetch?: typeof fetch } = {},
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
    query: { status?: EscalationStatus; agent?: string } = {},
  ): Promise<{ escalations: Escalation[] }> {
    return this.request('GET', '/escalations', undefined, query);
  }

  // ------------------------------------------------------------ project

  async summary(): Promise<Record<string, unknown>> {
    return this.request('GET', '');
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
