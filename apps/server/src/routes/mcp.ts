import { hashToken } from '../ids.js';
import { record, recordFirstWrite } from '../events.js';
import { clientIp } from './api.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import {
  STORE_UNAVAILABLE,
  TOKEN_IS_SHOWN_ONCE,
  nobodyIsListening,
  nobodyWasTold,
  ownerNotSent,
} from '../content.js';
import { storeUnreachable, type Store } from '../db.js';
import { maybeExpireClaims, maybeSweep } from '../hygiene.js';
import type { Notifier } from '../notify.js';
import type { RateLimiter } from '../rateLimit.js';
import { boardFacets, loadBoard, moveItem } from '../board.js';
import { boardApplyJson, boardJson, escalationJson, itemJson } from '../serialize.js';
import {
  ServiceError,
  looksLikeEmail,
  authenticate,
  acknowledgeEscalation,
  claimItem,
  heartbeatClaim,
  createEscalation,
  createProject,
  appendNote,
  getItem,
  listEscalations,
  readInbox,
  readItems,
  nextItem,
  nextItemHeld,
  type UpsertItemInput,
  observe,
  registerAgent,
  releaseItem,
  shareProject,
  upsertItem,
  writeWarnings,
} from '../service.js';
import {
  ESCALATION_PRIORITIES,
  ITEM_STATUSES,
  type EscalationPriority,
  type ItemStatus,
} from '../types.js';

/**
 * MCP over Streamable HTTP.
 *
 * Deliberately small. The market audit found a hosted competitor advertising
 * 125 MCP tools, which is a way of saying the model has to read a 125 item menu
 * before it can do anything. Muster exposes the same calls its curl surface
 * has, named the same way, so an agent that read skill.md already knows this
 * API.
 */

/**
 * The revisions of the protocol this speaks, newest first.
 *
 * The handshake used to answer with whatever the client asked for, which meant
 * claiming to speak every revision that exists and several that do not: a
 * client sending `1999-01-01` was told yes. A client that then relies on a
 * behaviour of the revision it named finds out by misbehaving rather than by
 * being told, which is the failure the negotiation exists to prevent.
 *
 * The rule the spec gives is the one implemented here: answer with the version
 * the client asked for when it is one we speak, and otherwise with the newest
 * we do, leaving the client to decide whether it can live with that.
 */
// 2024-11-05 is deliberately not on this list: that revision's transport is
// HTTP with a long-lived SSE stream, which this route does not implement and
// answers 405 to, so confirming it would be the same lie in a smaller font.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
const DEFAULT_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** How many JSON-RPC requests one batch may carry. */
const MAX_BATCH = 25;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpDeps {
  store: Store;
  config: Config;
  limiter: RateLimiter;
  notifier: Notifier;
}

/**
 * What a client is allowed to assume before it runs the tool.
 *
 * These are hints in the protocol and a decision in practice: several clients
 * run a read-only tool without asking anybody, so the flattering answer is the
 * one that gets a write executed unattended. Every field is set explicitly on
 * every tool for that reason, and a tool that writes on one branch and not on
 * the other is annotated for the branch that writes.
 *
 * - readOnly: cannot change anything, on any argument.
 * - destructive: may undo or close somebody's work, not only add to it.
 * - idempotent: calling it twice with the same arguments leaves the same state
 *   as calling it once. A timeline entry per call is an effect, so a tool that
 *   appends one is not idempotent however stable its key is.
 * - openWorld: reaches past this project, which here means it sends mail to a
 *   person.
 */
interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresProject: boolean;
  /**
   * Which of the two published budgets a call spends.
   *
   * Not derivable from `readOnlyHint`, which answers a different question: a
   * tool that writes on one branch is annotated for the branch that writes, so
   * a client never auto-approves it, while the budget should follow the branch
   * actually taken. Required rather than defaulted, because the list this
   * replaced was a set of names kept by hand next to the tools, and a tool
   * added without a line there was charged as a read for ever.
   */
  charges: 'read' | 'write';
  annotations: ToolAnnotations;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A string argument, or a refusal naming it.
 *
 * `str` substitutes a default, which is right for a name that has one and
 * wrong for anything that ends up in a query: an argument arriving as
 * `{"$ne": null}` became the empty string and the filter quietly widened, or
 * went through as an object and became an operator. Nothing validates on this
 * door, because MCP arguments are whatever a model produced, so the reading is
 * the validation.
 */
function text(value: unknown, name: string): string | undefined {
  // Absent is absent; `null` is a value somebody sent. Reading them the same
  // way is how `{"agent": null}` became "no agent filter" and answered with
  // every agent's inbox, which is the refusal this function exists to give.
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ServiceError(400, 'bad_argument', `"${name}" is a string here, and this one is not.`);
  }
  return value;
}

/**
 * A string this call cannot do without, or a refusal naming it.
 *
 * `str` substitutes a default and `text` allows absence, and between them the
 * slug read as an empty one: `{"slug": 42}` became "" and the caller was told
 * its slug had no alphanumeric characters, which is true of "" and not of 42.
 * The slug is what selects the card, so being wrong about why it was refused
 * costs an agent the one retry it might have got right.
 */
function required(value: unknown, name: string): string {
  const given = text(value, name);
  if (given === undefined || given.trim() === '') {
    throw new ServiceError(400, 'bad_argument', `"${name}" is required here, and this call has none.`);
  }
  return given;
}

/**
 * An object, or a refusal. Same reason as the two above.
 *
 * A model writing arguments gets this one wrong in a particular way: it sends
 * the thing it wanted to record as a string, or wraps it in an array. Turning
 * that into `undefined` and answering 200 would tell the caller its notes were
 * kept when nothing was, which is the one thing this door does not do
 * anywhere else.
 */
function object(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceError(400, 'bad_argument', `"${name}" is an object here, and this one is not.`);
  }
  return value as Record<string, unknown>;
}

/** Every element a string, or a refusal. Same reason, including the null. */
function texts(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ServiceError(400, 'bad_argument', `"${name}" is an array of strings here.`);
  }
  return value as string[];
}

/**
 * `arguments` is an envelope, and a word that misses it is gone.
 *
 * `tools/call` with `{"name":"list_items","limit":1,"arguments":{...}}` answered
 * 200 with fifty items while the caller believed it had asked for one: the
 * argument landed one layer out, in the protocol's object rather than the
 * tool's, and nothing said so. An argument the tool does not have at all fared
 * no better, and there the two doors disagreed outright, because over HTTP the
 * same word in a body is refused by name and told what the call does take.
 *
 * Narrower here than over HTTP, and deliberately: `params` belongs to the
 * protocol, not to us, so `_meta` and whatever the spec adds next have to pass
 * through untouched. Only a key that is a declared field of the tool being
 * called is refused, because only then is there no doubt where it was meant to
 * go.
 */
const PROTOCOL_KEYS = new Set(['name', 'arguments', '_meta']);

function refuseArgumentsThisToolHasNot(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  const fields = Object.keys(
    (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
  );
  const takes = fields.length > 0 ? `It takes ${fields.join(', ')}.` : 'It takes none.';

  const misplaced = Object.keys(params).filter(
    (key) => !PROTOCOL_KEYS.has(key) && fields.includes(key),
  );
  if (misplaced.length > 0) {
    const named = misplaced.map((key) => `"${key}"`).join(', ');
    throw new ServiceError(
      400,
      'misplaced_argument',
      `${named} ${misplaced.length === 1 ? 'is an argument' : 'are arguments'} of "${tool.name}", ` +
        `and ${misplaced.length === 1 ? 'it arrived' : 'they arrived'} beside "arguments" instead of ` +
        `inside it. Running the call anyway would answer 200 to a question nobody asked, with the ` +
        `default in place of what you sent. Move ${misplaced.length === 1 ? 'it' : 'them'} into ` +
        `params.arguments.`,
      { misplaced, accepted: fields },
    );
  }

  const unknown = Object.keys(args).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    const named = unknown.map((key) => `"${key}"`).join(', ');
    throw new ServiceError(
      400,
      'unknown_argument',
      `${named} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} "${tool.name}" has. ` +
        `${takes} Dropping what you sent and answering anyway is the one thing this door will not do.`,
      { unknown, accepted: fields },
    );
  }
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_project',
    title: 'Create a project',
    description:
      'Create a Muster project and receive a token. This is the whole signup: no account, no human. Only needed once per repository or product.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Human readable project name' },
        description: {
          type: 'string',
          description: 'What this board is for, so an operator running several can tell them apart',
        },
        owner_email: {
          type: 'string',
          description:
            'The person this board answers to. They are written to once, with the link and what taking it does, and nothing after that. Use it when you are setting a board up for somebody rather than for yourself: an unclaimed board expires, and a person nobody told about theirs finds out when it is gone.',
        },
        owner_note: {
          type: 'string',
          description: 'Why you set it up, in your words. It goes in that message.',
        },
        agent: { type: 'string', description: 'Your handle, so the message says who set it up.' },
      },
    },
    requiresProject: false,
    charges: 'write',
    // A second call with the same name is a second project: nothing about the name
    // addresses anything. Open world because owner_email mails a person.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'register_agent',
    title: 'Register an agent',
    description:
      'Declare who you are and what you own. Scope is advisory: it decides what next_item offers you and warns you when you write outside it. It never blocks a write, and it never warns anyone else.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['handle'],
      properties: {
        handle: { type: 'string', description: 'Stable handle, e.g. errors-loop' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Slug prefixes, labels or owner names you claim' },
        description: { type: 'string' },
        // The HTTP door has taken this since the first day both doors existed,
        // the published client sends it, and the read side returns it on every
        // agent whichever door asks. A door that cannot write a field it hands
        // back is a door that quietly loses whatever an agent put there.
        meta: {
          type: 'object',
          additionalProperties: true,
          description: 'Anything else this agent wants recorded about itself. Handed back as it was given.',
        },
      },
    },
    requiresProject: true,
    charges: 'write',
    // The handle is the key, but registering again writes a new lastSeenAt and
    // replaces the scope somebody else may have declared under that handle.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'upsert_item',
    title: 'Create or update an item',
    description:
      'Idempotent on slug: the same slug always addresses the same item, so two sessions converge instead of duplicating. Never put a date in a slug.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'Stable key, e.g. errors:withdraw-stuck' },
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: [...ITEM_STATUSES] },
        owner: { type: 'string' },
        priority: { type: 'integer', minimum: -10, maximum: 10 },
        labels: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Set when the item mirrors an external signal' },
        fields: {
          type: 'object',
          additionalProperties: true,
          description:
            'Values kept from the system this item came from. A board column can filter on them, so a column for "investigating" in another tracker is reachable from here.',
        },
        note: { type: 'string', description: 'Timeline entry describing this change' },
        actor: { type: 'string', description: 'Your agent handle' },
        expect: {
          type: 'object',
          description:
            'Write only if the item still says this. Between reading a card and writing it there is room for exactly the change this is trying not to lose; a mismatch refuses with changed_underneath and writes nothing. Not with status, which has its own guard.',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          additionalProperties: false,
        },
        then: {
          type: 'object',
          description:
            'The card to file when this one is finished, addressed by slug, so finishing twice files one card. A pipeline written on the work itself: one write says what to do and what to do next.',
          required: ['slug'],
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            priority: { type: 'integer', minimum: -10, maximum: 10 },
            labels: { type: 'array', items: { type: 'string' } },
            owner: { type: 'string' },
          },
        },
        blocked_by: {
          type: 'array',
          items: { type: 'string' },
          description: 'The cards this one is waiting on, by slug. Data and not a status: nothing on the server moves an item because of it, and `blocked` still means waiting on a person. What it does is keep this card out of what /next offers and refuse a claim on it, naming what is unfinished, so a fleet stops picking up work whose prerequisite is not done. An empty array clears it. A slug nobody has filed counts as unfinished and the refusal says so.',
        },
        must_exist: {
          type: 'boolean',
          description:
            'Refuse to create. Send it when you mean to change something that is already there and a new card would be wrong.',
        },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Idempotent on the card, not on the call: a note or a status change writes a
    // timeline entry every time. Destructive because an existing slug can have its
    // title, body, owner and labels replaced, or be closed outright.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'claim_item',
    title: 'Claim an item',
    description:
      'Take a lease before working. A refusal names the current holder. Claims expire without a heartbeat, so a crashed session never blocks the board.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'agent'],
      properties: {
        slug: { type: 'string' },
        agent: { type: 'string' },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Claiming again extends the lease, which is a different expiry and so a different state.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'heartbeat',
    title: 'Keep a claim alive',
    description:
      'Extend the lease on an item you hold while the work is still running. A lapsed lease cannot be extended, only claimed again, because between expiry and the sweep the item is already fair game for everybody else.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'agent'],
      properties: {
        slug: { type: 'string' },
        agent: { type: 'string' },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
    },
    requiresProject: true,
    charges: 'write',
    // A later expiry is a different state, so calling it again does something.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'release',
    title: 'Hand an item back',
    description:
      'Give up the lease without closing the item, so somebody else can pick it up now rather than when it expires. Say why in the note: the next agent reads the timeline to decide whether to take it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'agent'],
      properties: {
        slug: { type: 'string' },
        agent: { type: 'string' },
        note: { type: 'string' },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Not destructive: it gives up the caller's own lease and takes nothing
    // away from the record. Idempotent for the same reason the HTTP call is,
    // which is deliberate: releasing what nobody holds is what the caller
    // wanted anyway, and a close already releases, so the release in a
    // `finally` arrives second on the documented path.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'append_note',
    title: 'Append a timeline note',
    description:
      'Record what you learned. The next agent reads the timeline to decide whether to pick this up.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'message'],
      properties: {
        slug: { type: 'string' },
        message: { type: 'string' },
        actor: { type: 'string' },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Appending is the point.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'next_item',
    title: 'What to pick up next',
    description:
      'A look by default: the oldest unclaimed open item inside your declared scope, offered and not held. Pass claim to take it in the same call, which is what a fleet wants. If there is none you are told so, rather than handed somebody else’s work.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string' },
        claim: {
          type: 'boolean',
          description:
            'Take the lease in the same call. Without it, a fleet asking at once is offered the same item and all but one lose the claim that follows.',
        },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
    },
    requiresProject: true,
    charges: 'read',
    // Annotated for the branch that writes: with claim it takes a lease, and a client cannot tell which branch it gets before it calls.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'read_item',
    title: 'Read one item with its history',
    description:
      'One card by slug, with its timeline: the notes, the moves and who wrote them. The lists hand back timeline_count and never the entries, so this is the call that answers why a card is where it is. The last fifty entries are kept, and timeline_count is the true total, so the two differ on a long-running card and the count is the one to trust.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'The stable name, as it appears on the board.' },
      },
    },
    requiresProject: true,
    charges: 'read',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_items',
    title: 'List items',
    description:
      'Filter by status, owner, label, source, namespace, staleness or claim state. Pages with next_cursor, and as_of is what to pass back as since to read only what changed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: [...ITEM_STATUSES] },
        owner: { type: 'string' },
        label: { type: 'string' },
        source: { type: 'string' },
        prefix: {
          type: 'string',
          description:
            'Slug starts with this. Boards name their cards `area:thing`, so prefix "ops:" is everything in one area. Anchored, so it bounds the read to its own stretch of the slug index, which q cannot do: a substring over two fields is not answerable from an index. The two combine, and this is the half that makes the search cheaper. status narrows the read too; label narrows the answer and not the read, because labels carry no index here. board_facets lists the namespaces this board has.',
        },
        stale: { type: 'boolean' },
        claimed: {
          type: 'boolean',
          description:
            'true for items somebody holds right now, false for free ones. An expired lease counts as free.',
        },
        q: {
          type: 'string',
          description:
            'Words to look for in the slug or the title, case insensitive: every word has to appear, in either field, in any order. Past 120 characters or six words it is cut, not refused. A search that reads for longer than it is allowed is refused with search_too_slow rather than answered with an empty list: narrow it with another word, or with status, owner or label beside it.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        order: {
          type: 'string',
          enum: ['urgency', 'id', 'recent'],
          description:
            'urgency (default) is most urgent first. id is stable while you page, which is what an export needs. recent is whatever happened last, first, which is the order to poll in. since filters in every order, this one included.',
        },
        since: {
          type: 'string',
          description:
            'Only what changed at or after this moment, in every order and not only in recent. Pass back the as_of from your previous read rather than your own clock. A since older than everything on the board matches everything on the board, which is the right answer and not a filter being ignored.',
        },
        cursor: {
          type: 'string',
          description:
            'From the previous page\'s next_cursor, read in the same order. A null next_cursor means that was the last page.',
        },
      },
    },
    requiresProject: true,
    charges: 'read',
    // Not read-only, and the reason is worth stating rather than hiding: a read
    // clears leases that have already lapsed, because a lapsed lease is free work
    // and nothing else would tell a poller so. It cannot close, drop or mark
    // anything, which is the whole point of hygiene's read path being one rule.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'observe',
    title: 'Report which mirrored items still exist',
    description:
      'Items of that source missing from the list start an absence streak and close only after N consecutive absences and M hours, so one failed poll cannot close live work.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'present'],
      properties: {
        source: { type: 'string' },
        present: { type: 'array', items: { type: 'string' } },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Closes items whose signal has been absent long enough, which is somebody else's work being ended.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'escalate',
    title: 'Ask the human',
    description:
      'File a question only the operator can answer, then keep working on something else and read answers with the inbox tool.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
        priority: { type: 'string', enum: [...ESCALATION_PRIORITIES] },
        item_slug: { type: 'string' },
        agent: { type: 'string' },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Files a question and mails the operator, so a retry is a second question in a human's queue and a second mail.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'acknowledge',
    title: 'Say you have acted on an answer',
    description:
      'Clear an answered question out of your inbox once you have done what it says. Until you do, inbox keeps handing it back, and a second agent has no way of telling that somebody already acted on it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'agent'],
      properties: {
        id: { type: 'string' },
        agent: { type: 'string' },
        note: { type: 'string' },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Once. The second caller is refused by name, which is the point: two
    // agents acting on one answer is the thing this stops.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'board',
    title: 'See the board',
    description:
      'The project’s columns as its operator laid them out, with the items in each. Columns are a view over status, labels, owner and claim state, so reading the board tells you how this project wants work described.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'boolean', description: 'false for counts only' },
        include_closed: {
          type: 'boolean',
          description: 'Include done and dropped items, which the board leaves out by default',
        },
        owner: { type: 'string', description: 'Only items assigned to this owner' },
        agent: {
          type: 'string',
          description: 'Only items this agent is on: holding the claim, or the last to write',
        },
      },
    },
    requiresProject: true,
    charges: 'read',
    // Not read-only, and the reason is worth stating rather than hiding: a read
    // clears leases that have already lapsed, because a lapsed lease is free work
    // and nothing else would tell a poller so. It cannot close, drop or mark
    // anything, which is the whole point of hygiene's read path being one rule.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'board_facets',
    title: 'The vocabularies this board uses',
    description:
      'The owners, agents, labels and slug namespaces that actually occur on this board. Read it before narrowing: a filter typed from memory comes back empty, and empty reads as no work rather than as a wrong word. The prefixes it lists are the namespaces in the slugs, which is the grouping the agents wrote themselves, and each one goes back to list_items as its prefix argument. Every list says how many names it left off for length.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    requiresProject: true,
    charges: 'read',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'move',
    title: 'Move an item into a column',
    description:
      'Puts an item in a column of this board, doing whatever that column says belongs there: a status, a label, an owner, a claim. Read the board first to see the column keys. The answer says which column it actually landed in, which is not always the one you asked for.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'column'],
      properties: {
        slug: { type: 'string' },
        column: { type: 'string', description: 'The column key, from the board tool' },
        note: { type: 'string' },
        agent: { type: 'string' },
      },
    },
    requiresProject: true,
    charges: 'write',
    // A column can carry a terminal status, release somebody's claim or replace an
    // owner, and the note lands on the timeline each time.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'share_project',
    title: 'Hand this board to a human',
    description:
      'Offers the project to an operator by email. It appears in their view where one click makes them the owner, which also lifts the limits and stops the project expiring. Needs an admin token, because this is how a project changes hands and ownership has no way back. Use it to answer a handover_requests entry from the inbox tool, and never send anybody the project token.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['email'],
      properties: {
        email: { type: 'string' },
        note: { type: 'string', description: 'Why you are handing it over' },
        agent: { type: 'string' },
      },
    },
    requiresProject: true,
    charges: 'write',
    // Ownership has no way back, and it mails an address you name.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'inbox',
    title: 'Read the operator’s answers',
    description:
      'Four statuses, four meanings: answered (act on it), resolved (already handled, stop), wont_do (dropped, do not ask again), in_progress (wait, do not duplicate).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { agent: { type: 'string' } },
    },
    requiresProject: true,
    charges: 'read',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

/**
 * How many tools the MCP server offers, for the documents that say so.
 *
 * Written down in three places once, and drifted in all three: the protocol
 * map said eight, the docs page said ten, and the server had thirteen. A
 * number a reader can check is a number that has to come from the list.
 */
export const TOOL_COUNT = TOOLS.length;

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const { store, config, limiter, notifier } = deps;

  app.get('/mcp', { schema: { hide: true } }, async (request, reply) => {
    /**
     * The official SDK opens a standalone GET with `accept: text/event-stream`
     * and expects 405 from a server that does not offer a stream there. We
     * answered 200 with a friendly info card, the SDK read that as a stream
     * that closed immediately, and reconnected about once a second for as long
     * as the client stayed open: measured at 0.9 requests a second per idle
     * client, which is eighty thousand a day, unmetered, from a client doing
     * nothing at all.
     *
     * So the answer depends on who is asking, which is what the header is for.
     * A person who pasted the URL into a browser still gets the card.
     */
    const wantsStream = String(request.headers.accept ?? '').includes('text/event-stream');
    if (wantsStream) {
      return reply.code(405).header('allow', 'POST').send({
        error: 'method_not_allowed',
        message:
          'This MCP endpoint has no server-initiated stream. Send JSON-RPC 2.0 over POST; the response carries everything.',
      });
    }
    // A plain GET is not an MCP handshake. Say what this endpoint is instead of
    // returning a protocol error to a human who pasted the URL in a browser.
    return reply.type('application/json').send({
      name: 'muster',
      version: '0.1.0',
      transport: 'streamable-http',
      usage: 'POST JSON-RPC 2.0 here: initialize, tools/list, tools/call.',
      authentication: 'authorization: Bearer <project token>',
      card: `${config.baseUrl}/.well-known/mcp.json`,
      instructions: `${config.baseUrl}/skill.md`,
      tools: TOOLS.map((tool) => tool.name),
    });
  });

  app.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    const body = request.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
    if (Array.isArray(body)) {
      // A JSON-RPC batch is one HTTP request and as many pieces of work as it
      // has members. Left uncapped, a megabyte of body is several thousand
      // tool calls that the per-request limiter counts once, so one client
      // turns a rate limit into a suggestion. Real clients batch a handful.
      if (body.length > MAX_BATCH) {
        return reply.code(400).send({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: `A batch holds at most ${MAX_BATCH} requests; this one had ${body.length}. Send them in smaller batches.`,
          },
        });
      }
      const results = [];
      for (const entry of body) {
        const result = await handle(entry, request, reply);
        if (result !== undefined) results.push(result);
      }
      return results.length > 0 ? reply.send(results) : reply.code(202).send();
    }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return reply.code(400).send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message:
            'Not a JSON-RPC 2.0 request. This is an MCP Streamable HTTP endpoint; see /.well-known/mcp.json.',
        },
      });
    }
    const result = await handle(body, request, reply);
    if (result === undefined) return reply.code(202).send();
    return reply.send(result);
  });

  async function handle(
    message: JsonRpcRequest,
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<unknown> {
    const id = message.id ?? null;
    const params = message.params ?? {};

    try {
      switch (message.method) {
        case 'initialize': {
          const requested = str((params as { protocolVersion?: unknown }).protocolVersion);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
                ? requested
                : DEFAULT_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'muster', version: '0.1.0' },
              instructions:
                'Shared operational memory for long-lived agents. Read ' +
                `${config.baseUrl}/skill.md once; the tools here mirror it exactly.`,
            },
          };
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return undefined;
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS.map((tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
              })),
            },
          };
        case 'tools/call': {
          const name = str((params as { name?: unknown }).name);
          const args = ((params as { arguments?: unknown }).arguments ?? {}) as Record<
            string,
            unknown
          >;
          const tool = TOOLS.find((candidate) => candidate.name === name);
          if (!tool) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown tool "${name}".` },
            };
          }
          refuseArgumentsThisToolHasNot(tool, (params ?? {}) as Record<string, unknown>, args);
          const output = await callTool(tool, args, request);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            },
          };
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unsupported method "${message.method}".` },
          };
      }
    } catch (error) {
      // The store being out of reach is not this service having a bug, and a
      // client branching on the code should read the same one here as over
      // HTTP: 503 store_unavailable means come back, 500 internal does not.
      const unreachable = storeUnreachable(error);
      const status = error instanceof ServiceError ? error.statusCode : unreachable ? 503 : 500;
      const text = unreachable
        ? STORE_UNAVAILABLE
        : error instanceof Error
          ? error.message
          : 'Unexpected error';
      // The code as well as the sentence. The sentence is for whoever reads the
      // transcript; the code is what a loop branches on, and over HTTP it has
      // always been there. Without it this door left an agent matching prose to
      // tell "somebody wrote to it first" from "you are over the cap".
      const code = error instanceof ServiceError
        ? error.code
        : unreachable
          ? 'store_unavailable'
          : 'internal';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `${status} ${code}: ${text}` }],
          // The delay too, because a batch is many calls in one response and a
          // per-call header cannot say which of them should wait.
          structuredContent: { error: text, code, status, ...(unreachable ? { retry_after: 5 } : {}) },
          isError: true,
        },
      };
    }
  }

  async function callTool(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    request: FastifyRequest,
  ): Promise<Record<string, unknown>> {
    if (!tool.requiresProject) {
      // The same published limit as POST /p. A tool call is a cheaper way to
      // ask for a project, not a way around the cap.
      const ip = clientIp(request);
      const verdict = limiter.check(`create:${ip}`, config.rateLimits.createProject);
      if (!verdict.ok) {
        throw new ServiceError(
          429,
          'rate_limited',
          `Too many new projects from this address. Retry in ${verdict.retryAfterSeconds}s. If you already have a project, use its token instead of making another.`,
        );
      }
      // Both questions about the address, before anything is written: a
      // refusal after the fact costs the caller the project it just made and
      // the token it was shown once, and its retry makes another one. Same
      // split as the HTTP door: a malformed address creates nothing, a full
      // bucket is somebody else's mail volume and does not cost this caller
      // its board.
      const offered = text(args.owner_email, 'owner_email')?.trim();
      if (offered && !looksLikeEmail(offered)) {
        throw new ServiceError(400, 'bad_email', 'That does not look like an email address.');
      }
      const mayWrite = offered
        ? limiter.check(`offer:${offered.toLowerCase()}`, config.rateLimits.claimEmail)
        : null;
      const { project, adminToken } = await createProject(
        store,
        config,
        {
          name: str(args.name, 'Untitled project'),
          description: str(args.description),
        },
        'mcp',
      );
      if (offered && mayWrite?.ok) {
        await shareProject(store, project, {
          email: offered,
          note: text(args.owner_note, 'owner_note') ?? '',
          offeredBy: text(args.agent, 'agent') ?? '',
        });
        await notifier.boardOffered(project, {
          email: offered,
          note: text(args.owner_note, 'owner_note') ?? '',
          offeredBy: text(args.agent, 'agent') ?? '',
        });
      }
      return {
        project: project._id,
        name: project.name,
        description: project.description,
        token: adminToken,
        api: `${config.baseUrl}/v1/${project._id}`,
        read_url: `${config.baseUrl}/r/${project.readToken}`,
        board_url: `${config.baseUrl}/r/${project.readToken}/board`,
        expires_at: project.expiresAt,
        // The same facts POST /p hands back. An agent that came in through
        // this door was told less about the board it had just made than one
        // that came in through the other: no caps, and no names for the two
        // calls it will need next.
        limits: project.limits,
        next: {
          instructions: `${config.baseUrl}/skill.md`,
          claim_to_keep: `${config.baseUrl}/v1/${project._id}/claim`,
          hand_to_a_human: `${config.baseUrl}/v1/${project._id}/share`,
        },
        ...(offered
          ? mayWrite?.ok
            ? { owner_notified: offered }
            : {
                owner_notified: false,
                owner_notice: ownerNotSent(
                  `${config.baseUrl}/r/${project.readToken}`,
                  mayWrite?.retryAfterSeconds ?? 0,
                ),
              }
          : {}),
        notice: TOKEN_IS_SHOWN_ONCE,
        // Where a token has to go, without claiming more than is true. This
        // endpoint reads the header on every request and holds no session
        // state, so a caller that can set a header per call is already
        // finished. What it cannot do is help a client that reads its headers
        // once from a configuration file, which is most of the ones a person
        // installs, and that is the case worth naming.
        how_to_use_this_token:
          'Send it as "authorization: Bearer <token>" on your next call: this endpoint reads the header per request and keeps no session state. A client that takes its headers from a configuration file rather than per call needs the token written there and a reconnect; the same token also works over HTTP against the api URL above.',
      };
    }

    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : null;
    if (!token) {
      throw new ServiceError(
        401,
        'missing_token',
        'Send your project token as "authorization: Bearer <token>". Call create_project first if you do not have one.',
      );
    }

    // Charged per tool call, on the same buckets the REST surface uses. The
    // REST side limits in a preHandler, which counts one HTTP request; a batch
    // is many calls inside one request, so the count has to happen here or the
    // two doors publish the same limit and enforce different things. Charged
    // before the lookup, so an invalid token cannot spend a database query per
    // batch member either.
    // Asking what is next is a read; asking for it and taking it writes a
    // lease and a timeline entry, and charging that against the read budget
    // published five times the writes an agent is allowed. Every other tool
    // says which budget it spends on its own definition, because the list that
    // used to live here was a set of names beside the tools rather than on
    // them, and a tool added without a line in it was charged as a read for
    // ever. Two of them were, the day they were added.
    const kind =
      tool.charges === 'write' || (tool.name === 'next_item' && args.claim === true) ? 'w' : 'r';
    const verdict = limiter.check(
      `tok:${hashToken(token).slice(0, 16)}:${kind}`,
      kind === 'w' ? config.rateLimits.write : config.rateLimits.read,
    );
    if (!verdict.ok) {
      throw new ServiceError(
        429,
        'rate_limited',
        // Which of the two token buckets, because they are counted apart and
        // published apart: an agent told to slow down on writes has no reason
        // to stop reading.
        `Too many ${kind === 'w' ? 'writes' : 'reads'} for this token. Retry in ${verdict.retryAfterSeconds}s. Published limits live at ${config.baseUrl}/.well-known/agent-access.json.`,
      );
    }

    const { project, key } = await authenticate(store, token);
    const actor = str(args.actor) || str(args.agent) || 'unknown-agent';

    // Offering the project to a person decides who ends up owning it, and
    // ownership has no way back. The HTTP route asks for an admin key; a tool
    // call is the same act through a different door.
    if (tool.name === 'share_project' && key.role !== 'admin') {
      throw new ServiceError(
        403,
        'admin_required',
        'Offering this project to a person needs an admin token. The bootstrap token returned by create_project is one.',
      );
    }

    switch (tool.name) {
      case 'register_agent': {
        const { agent, created } = await registerAgent(store, project, {
          handle: str(args.handle),
          scope: Array.isArray(args.scope) ? (args.scope as string[]) : undefined,
          description: str(args.description),
          meta: object(args.meta, 'meta'),
        });
        if (created) record(store, 'register', { door: 'mcp', projectId: project._id });
        return { handle: agent.handle, scope: agent.scope, created };
      }
      case 'upsert_item': {
        const result = await upsertItem(store, project, {
          slug: required(args.slug, 'slug'),
          title: args.title === undefined ? undefined : str(args.title),
          body: args.body === undefined ? undefined : str(args.body),
          status: args.status as ItemStatus | undefined,
          owner: args.owner === undefined ? undefined : str(args.owner),
          priority: typeof args.priority === 'number' ? args.priority : undefined,
          labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined,
          source: args.source === undefined ? undefined : str(args.source),
          // A board column can filter on these, so an agent that cannot write
          // them cannot reach such a column. `history` stays off this door: it
          // is the one-time import path, admin only, and what carries it is a
          // migration script that already speaks HTTP.
          fields:
            args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
              ? (args.fields as Record<string, unknown>)
              : undefined,
          note: args.note === undefined ? undefined : str(args.note),
          // Both doors, same behaviour: a guarded write was reachable from the
          // browser's edit form and from nowhere an agent could call. Passed
          // as it arrived, and rebuilt from its two known fields in the
          // service, which is where every door's arguments meet the filter.
          expect: args.expect as { title?: string; body?: string } | undefined,
          then: args.then as UpsertItemInput['then'],
          blockedBy: texts(args.blocked_by, 'blocked_by'),
          mustExist: args.must_exist === true,
          actor,
        });
        if (result.created) recordFirstWrite(store, project._id, 'mcp');
        void maybeSweep(store, project).catch(() => undefined);
        return {
          item: itemJson(result.item),
          created: result.created,
          ...(result.chained ? { chained: itemJson(result.chained) } : {}),
          // The same remarks the other door makes. This one used to carry only
          // what the write itself noticed, so an agent working over MCP was
          // never told its handle was unregistered or its write outside its
          // own scope, on a service whose whole claim is that both doors are
          // the same door.
          warnings: [
            ...result.warnings,
            ...(await writeWarnings(store, project, actor, result.item)),
          ],
        };
      }
      case 'claim_item': {
        const result = await claimItem(
          store,
          project,
          required(args.slug, 'slug'),
          text(args.agent, 'agent') || actor,
          typeof args.ttl_minutes === 'number' ? args.ttl_minutes : undefined,
        );
        return result.ok
          ? { ok: true, item: itemJson(result.item!), expires_at: result.expiresAt }
          : {
              ok: false,
              held_by: result.heldBy,
              hint: 'Somebody else is on this. Pick something else.',
            };
      }
      case 'heartbeat': {
        const item = await heartbeatClaim(
          store,
          project,
          required(args.slug, 'slug'),
          text(args.agent, 'agent') || actor,
          typeof args.ttl_minutes === 'number' ? args.ttl_minutes : undefined,
        );
        return { ok: true, item: itemJson(item), expires_at: item.claim?.expiresAt ?? null };
      }
      case 'release': {
        const item = await releaseItem(
          store,
          project,
          required(args.slug, 'slug'),
          text(args.agent, 'agent') || actor,
          text(args.note, 'note') ?? undefined,
        );
        return { ok: true, item: itemJson(item) };
      }
      case 'append_note': {
        const item = await appendNote(
          store,
          project,
          required(args.slug, 'slug'),
          actor,
          required(args.message, 'message'),
        );
        const warnings = await writeWarnings(store, project, actor);
        return { item: itemJson(item), ...(warnings.length > 0 ? { warnings } : {}) };
      }
      case 'next_item': {
        void maybeSweep(store, project).catch(() => undefined);
        const asked = text(args.agent, 'agent') ?? '';
        const result =
          args.claim === true
            ? await nextItemHeld(
                store,
                project,
                asked,
                typeof args.ttl_minutes === 'number' ? args.ttl_minutes : undefined,
              )
            : await nextItem(store, project, asked);
        const warnings = asked ? await writeWarnings(store, project, asked) : [];
        return {
          item: result.item ? itemJson(result.item, true) : null,
          reason: result.reason,
          ...(result.claimed === undefined ? {} : { claimed: result.claimed }),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }
      case 'read_item': {
        // The lists on this door say `timeline_count` and never carry the
        // entries, so a client could see that four things had happened to a
        // card and had no call that would tell it what. The timeline is where
        // this product keeps the why, and the other door has always had it.
        //
        // Sweeping first, like every other read here. Reading one card was the
        // path that did not, on either door, so a lease that had run out came
        // back looking held while listing the same card called it free: one
        // service with two answers about one card, chosen by which call you
        // happened to make.
        void maybeExpireClaims(store, project).catch(() => undefined);
        const item = await getItem(store, project._id, required(args.slug, 'slug'));
        return { item: itemJson(item, true) };
      }
      case 'list_items': {
        // The same read the HTTP route makes. It used to be its own smaller
        // one: no cursor, so nothing past the limit existed on this door, no
        // since, so no incremental sync, and no claimed, which the tool
        // description had been promising all along.
        const { items, nextCursor, asOf } = await readItems(store, project, {
          status: text(args.status, 'status') as ItemStatus | undefined,
          owner: text(args.owner, 'owner'),
          label: text(args.label, 'label'),
          source: text(args.source, 'source'),
          prefix: text(args.prefix, 'prefix'),
          stale: typeof args.stale === 'boolean' ? args.stale : undefined,
          claimed: typeof args.claimed === 'boolean' ? args.claimed : undefined,
          q: text(args.q, 'q'),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          order: text(args.order, 'order'),
          cursor: text(args.cursor, 'cursor'),
          since: text(args.since, 'since'),
        });
        return {
          items: items.map((item) => itemJson(item)),
          next_cursor: nextCursor,
          as_of: asOf.toISOString(),
        };
      }
      case 'observe': {
        // Every slug a string: one object in this array reached
        // `normalizeSlug` and came back as a 500 rather than a refusal.
        const present = texts(args.present, 'present') ?? [];
        return { ...(await observe(store, project, text(args.source, 'source') ?? '', present)) };
      }
      case 'escalate': {
        const doc = await createEscalation(
          store,
          project,
          {
            agent: actor,
            question: str(args.question),
            context: str(args.context),
            priority: args.priority as EscalationPriority | undefined,
            itemSlug: args.item_slug === undefined ? null : str(args.item_slug),
          },
          'mcp',
        );
        await notifier.escalationRaised(project, doc);
        return {
          escalation: escalationJson(doc),
          read_url: `${config.baseUrl}/r/${project.readToken}`,
          // Same sentence as the HTTP door, for the same reason: a question
          // filed on a board nobody owns reaches nobody, and the agent has no
          // way of knowing that from the answer.
          hint: project.claimedBy
            ? 'Keep working on something else and read the inbox on your next iteration.'
            : nobodyWasTold('share_project', 'the inbox'),
        };
      }
      case 'acknowledge': {
        // The one tool that will not fall back to the session's handle. Every
        // other one either fails or no-ops when the handle is wrong; this one
        // consumes the answer for everybody, and the refusal that stops two
        // agents acting on one decision is by name. Acknowledged as
        // "unknown-agent" it leaves the intended agent's inbox for good and
        // tells the next caller somebody already did it.
        const who = (text(args.agent, 'agent') ?? '').trim();
        if (!who) {
          throw new ServiceError(
            400,
            'bad_argument',
            'Acknowledging is somebody saying they acted, so "agent" is required here and has to be your handle.',
          );
        }
        const doc = await acknowledgeEscalation(store, project, str(args.id), {
          agent: who,
          ...(text(args.note, 'note') ? { note: str(args.note) } : {}),
        });
        return { escalation: escalationJson(doc) };
      }
      case 'board': {
        void maybeExpireClaims(store, project).catch(() => undefined);
        const view = await loadBoard(store, project, {
          ...(typeof args.include_closed === 'boolean'
            ? { includeClosed: args.include_closed }
            : {}),
          // Both narrowings end up in the board's own filter.
          ...(text(args.owner, 'owner') ? { owner: text(args.owner, 'owner')! } : {}),
          ...(text(args.agent, 'agent') ? { agent: text(args.agent, 'agent')! } : {}),
        });
        return boardJson(view, args.items !== false);
      }
      case 'board_facets': {
        const facets = await boardFacets(store, project);
        return {
          owners: facets.owners,
          agents: facets.agents.map((agent) => agent.handle),
          agentsDescribed: facets.agents.filter((agent) => agent.description !== ''),
          labels: facets.labels,
          prefixes: facets.prefixes,
          omitted: facets.omitted,
        };
      }
      case 'move': {
        const result = await moveItem(store, project, {
          slug: required(args.slug, 'slug'),
          column: str(args.column),
          actor,
          ...(args.note === undefined ? {} : { note: str(args.note) }),
        });
        return {
          ok: true,
          item: itemJson(result.item),
          applied: boardApplyJson(result.applied),
          landed_in: result.landedIn,
          ...(result.chained ? { chained: itemJson(result.chained) } : {}),
          ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        };
      }
      case 'share_project': {
        const email = str(args.email);
        // The bucket that protects the person being written to rather than the
        // board being offered. The HTTP door caps offers per project; this one
        // had nothing, and a project token costs nothing to obtain, so a fleet
        // of fresh projects was a fleet of fresh senders pointed at one inbox.
        if (looksLikeEmail(email)) {
          const toThem = limiter.check(
            `offer:${email.trim().toLowerCase()}`,
            config.rateLimits.claimEmail,
          );
          if (!toThem.ok) {
            throw new ServiceError(
              429,
              'rate_limited',
              `That address has been written to enough for now. Retry in ${toThem.retryAfterSeconds}s, or hand them ${config.baseUrl}/r/${project.readToken} yourself.`,
            );
          }
        }
        const { alreadyOwned } = await shareProject(store, project, {
          email,
          note: str(args.note),
          offeredBy: actor,
        });
        if (alreadyOwned) return { ok: true, already_owned: true };
        // The step that reaches a human. Without it the offer waited in a view
        // this person may never have opened.
        await notifier.boardOffered(project, {
          email,
          note: str(args.note),
          offeredBy: actor,
        });

        // The same answer for every address, for the reason the HTTP endpoint
        // gives: whether somebody is already a user is not this caller's
        // business, and a project token costs nothing to obtain.
        return {
          ok: true,
          pending: true,
          tell_them: `${config.baseUrl}/r/${project.readToken}`,
          hint: 'Send them that link. If they already use Muster, the offer is also waiting in their operator view, where one click makes them the owner.',
        };
      }
      case 'inbox': {
        // The same function the HTTP route uses. This case used to page one
        // list of escalations and split it in memory, which meant an open
        // question fell off the end once a project had fifty answered ones,
        // and an answer already acted on kept coming back for ever.
        const asking = text(args.agent, 'agent');
        const { answers, waiting, handovers, offers } = await readInbox(store, project, {
          ...(asking ? { agent: asking } : {}),
        });
        return {
          answers: answers.map(escalationJson),
          waiting: waiting.map(escalationJson),
          ...(handovers.length > 0
            ? {
                handover_requests: handovers.map((doc) => ({
                  email: doc.email,
                  note: doc.note,
                  asked_at: doc.createdAt,
                })),
                hint: `Somebody wants this board. Hand it over with the share_project tool and their address. Never send them the project token.`,
              }
            : !project.claimedBy && waiting.length > 0
              ? { hint: nobodyIsListening(waiting.length, 'the share_project tool', offers > 0) }
              : {}),
        };
      }
      default:
        throw new ServiceError(400, 'unknown_tool', `Tool "${tool.name}" has no implementation.`);
    }
  }
}
