import type { Config } from './config.js';
import type { AgentDoc, EscalationDoc, ItemDoc, ProjectDoc } from './types.js';

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
    created_at: doc.createdAt,
  };
}

export function projectJson(project: ProjectDoc, config: Config): Record<string, unknown> {
  return {
    project: project._id,
    name: project.name,
    tier: project.tier,
    api: `${config.baseUrl}/v1/${project._id}`,
    read_url: `${config.baseUrl}/r/${project.readToken}`,
    claimed: project.claimedBy !== null,
    expires_at: project.expiresAt,
    limits: project.limits,
    counts: project.counts,
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
