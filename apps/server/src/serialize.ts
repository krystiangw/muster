import type { BoardView } from './board.js';
import type { Config } from './config.js';
import { redactAddress } from './email.js';
import {
  DEFAULT_BOARD,
  type AgentDoc,
  type BoardApply,
  type BoardConfig,
  type EscalationDoc,
  type ItemDoc,
  type ProjectDoc,
} from './types.js';

/**
 * The wire format is snake_case and flat. Agents copy these keys straight out
 * of the docs into request bodies, so the two have to look the same.
 */

export function itemJson(item: ItemDoc, includeTimeline = false): Record<string, unknown> {
  const json: Record<string, unknown> = {
    slug: item.slug,
    title: item.title,
    body: item.body,
    status: item.status,
    owner: item.owner,
    priority: item.priority,
    labels: item.labels,
    source: item.source,
    fields: item.fields,
    stale: item.stale,
    // Who touched it last. On a board with six agents this is the difference
    // between a queue of work and a queue of anonymous work.
    last_actor: item.lastActor ?? null,
    claim: item.claim
      ? {
          agent: item.claim.agent,
          expires_at: item.claim.expiresAt,
          heartbeat_at: item.claim.heartbeatAt,
        }
      : null,
    absence: item.absence?.count ? { count: item.absence.count, since: item.absence.since } : null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    touched_at: item.touchedAt,
    closed_at: item.closedAt,
    timeline_count: item.timelineCount,
  };
  if (includeTimeline && item.timeline) {
    json.timeline = item.timeline.map((entry) => ({
      at: entry.at,
      by: entry.by,
      kind: entry.kind,
      message: entry.message,
    }));
  }
  return json;
}

export function agentJson(agent: AgentDoc): Record<string, unknown> {
  return {
    handle: agent.handle,
    scope: agent.scope,
    description: agent.description,
    registered_at: agent.registeredAt,
    last_seen_at: agent.lastSeenAt,
    meta: agent.meta,
  };
}

export function escalationJson(doc: EscalationDoc): Record<string, unknown> {
  return {
    id: doc._id,
    agent: doc.agent,
    question: doc.question,
    context: doc.context,
    priority: doc.priority,
    status: doc.status,
    answer: doc.answer,
    answered_at: doc.answeredAt,
    item_slug: doc.itemSlug,
    // What happened after the answer, which is a different question from what
    // the answer was. Null means nobody has acted on it yet.
    acted_at: doc.acknowledgedAt ?? null,
    acted_by: doc.acknowledgedBy ?? null,
    acted_note: doc.acknowledgedNote ?? null,
    created_at: doc.createdAt,
  };
}

/**
 * A column's move semantics, in the same snake_case the rest of the API speaks.
 * It has to round-trip: a layout read here and written back must still say what
 * moving into each column does, or the settings form silently erases it.
 */
export function boardApplyJson(apply: BoardApply): Record<string, unknown> {
  return {
    ...(apply.status === undefined ? {} : { status: apply.status }),
    ...(apply.addLabels ? { add_labels: apply.addLabels } : {}),
    ...(apply.removeLabels ? { remove_labels: apply.removeLabels } : {}),
    ...(apply.owner === undefined ? {} : { owner: apply.owner }),
    ...(apply.priority === undefined ? {} : { priority: apply.priority }),
    ...(apply.claim === undefined ? {} : { claim: apply.claim }),
    ...(apply.release === undefined ? {} : { release: apply.release }),
    ...(apply.touch === undefined ? {} : { touch: apply.touch }),
  };
}

export function boardConfigJson(config: BoardConfig): Record<string, unknown> {
  return {
    rows: config.rows,
    columns: config.columns.map((column) => ({
      key: column.key,
      title: column.title,
      ...(column.hint ? { hint: column.hint } : {}),
      ...(column.apply ? { apply: boardApplyJson(column.apply) } : {}),
      match: {
        ...(column.match.status ? { status: column.match.status } : {}),
        ...(column.match.labels ? { labels: column.match.labels } : {}),
        ...(column.match.notLabels ? { not_labels: column.match.notLabels } : {}),
        ...(column.match.owner ? { owner: column.match.owner } : {}),
        ...(column.match.claimed === undefined ? {} : { claimed: column.match.claimed }),
        ...(column.match.stale === undefined ? {} : { stale: column.match.stale }),
        ...(column.match.source ? { source: column.match.source } : {}),
        ...(column.match.priorityMin === undefined
          ? {}
          : { priority_min: column.match.priorityMin }),
        ...(column.match.fields ? { fields: column.match.fields } : {}),
      },
    })),
  };
}

export function boardJson(view: BoardView, includeItems = true): Record<string, unknown> {
  return {
    board: boardConfigJson(view.config),
    totals: view.totals,
    unplaced: view.unplaced,
    partial: view.partial,
    // Present and empty on an unfiltered board, so a caller reading counts
    // always knows whether it is looking at all of the work or some of it.
    filter: {
      ...(view.filter.owner ? { owner: view.filter.owner } : {}),
      ...(view.filter.agent ? { agent: view.filter.agent } : {}),
    },
    rows: view.rows.map((row) => ({
      key: row.key,
      title: row.title,
      columns: row.columns.map((cell) => ({
        key: cell.key,
        title: cell.title,
        ...(cell.hint ? { hint: cell.hint } : {}),
        count: cell.count,
        truncated: cell.truncated,
        ...(includeItems ? { items: cell.items.map((item) => itemJson(item)) } : {}),
      })),
    })),
  };
}

export function projectJson(project: ProjectDoc, config: Config): Record<string, unknown> {
  return {
    project: project._id,
    name: project.name,
    description: project.description ?? '',
    visibility: project.visibility ?? 'link',
    tier: project.tier,
    api: `${config.baseUrl}/v1/${project._id}`,
    read_url: `${config.baseUrl}/r/${project.readToken}`,
    board: boardConfigJson(project.board ?? DEFAULT_BOARD),
    claimed: project.claimedBy !== null,
    // Enough of the address to recognise, never the whole one. An agent that
    // cannot see whether the board it writes to has an owner cannot notice
    // that the answer changed; it has no business holding the person's email,
    // and when it needs one to hand the project over, the request in /inbox
    // carries exactly that address and no other.
    claimed_by: project.claimedBy ? redactAddress(project.claimedBy) : null,
    claimed_at: project.claimedAt,
    expires_at: project.expiresAt,
    limits: project.limits,
    counts: project.counts,
    // When a sweep last finished, from either path: the scheduled pass or the
    // throttled one a request triggers. The stale flags and the expired claims
    // in `counts` are exactly as old as this, and a sweeper that quietly
    // stopped looks identical to a board with nothing to tidy until somebody
    // can read the date. Deliberately not the throttle marker, which is taken
    // before the work and so keeps moving through a sweep that throws.
    swept_at: project.sweptAt ?? null,
    rules: {
      stale_after_hours: project.rules.staleAfterHours,
      absence_resolve: project.rules.absenceResolve
        ? {
            observations: project.rules.absenceResolve.observations,
            min_hours: project.rules.absenceResolve.minHours,
          }
        : null,
      require_body_after_hours: project.rules.requireBodyAfterHours,
      claim_ttl_minutes: project.rules.claimTtlMinutes,
      scope_warnings: project.rules.scopeWarnings,
    },
  };
}
