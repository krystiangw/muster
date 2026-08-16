import type { Store } from './db.js';
import { TERMINAL_STATUSES, type HygieneRules, type ProjectDoc } from './types.js';

/**
 * The hygiene engine.
 *
 * Every rule here exists because a real board rotted without it. The reference
 * failures are measured on the board this replaced: 506 frozen
 * tickets, 63 items left unroutable by an enum drift, and a
 * handover that claimed 56 shipped features when the database held two.
 *
 * Three invariants keep the engine trustworthy:
 *
 *  1. Every automatic change writes a timeline entry signed `hygiene`, so no
 *     state moves without a visible cause.
 *  2. Automatic changes never move `touchedAt`. Hygiene must not look like
 *     activity, or a stale item would keep resetting its own staleness clock.
 *  3. Every automatic change is reversible by an ordinary upsert on the same
 *     slug, so an agent can always undo the machine.
 */

export const TIMELINE_KEEP = 50;

export interface HygieneOutcome {
  rule: 'claim_expiry' | 'stale' | 'require_body' | 'absence_resolve';
  affected: number;
}

/** Builds the pipeline-update fragment that appends one timeline entry. */
function appendTimeline(message: unknown, now: Date): Record<string, unknown> {
  return {
    timeline: {
      $slice: [
        {
          $concatArrays: [
            { $ifNull: ['$timeline', []] },
            [{ at: now, by: 'hygiene', kind: 'hygiene', message }],
          ],
        },
        -TIMELINE_KEEP,
      ],
    },
    timelineCount: { $add: [{ $ifNull: ['$timelineCount', 0] }, 1] },
    updatedAt: now,
  };
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

/**
 * Closing work frees its slot, and the rule that closed it says so immediately.
 * Leaving that to the end of a sweep breaks `observe`, which runs the absence
 * rule on its own: an agent could close ten mirrored items and still be told
 * the project was full on its very next write.
 */
async function releaseSlots(store: Store, projectId: string, count: number): Promise<void> {
  if (count <= 0) return;
  await store.projects.updateOne({ _id: projectId }, { $inc: { 'counts.items': -count } });
}

/**
 * Releases claims whose heartbeat stopped. Without this, one crashed session
 * holds a ticket forever and every other agent politely skips it.
 */
export async function expireClaims(
  store: Store,
  projectId: string,
  now: Date,
): Promise<HygieneOutcome> {
  const result = await store.items.updateMany(
    { projectId, 'claim.expiresAt': { $lte: now } },
    [
      {
        $set: {
          ...appendTimeline(
            {
              $concat: [
                'claim by ',
                { $ifNull: ['$claim.agent', 'unknown'] },
                ' expired without a heartbeat, item is free again',
              ],
            },
            now,
          ),
          claim: null,
        },
      },
    ],
  );
  return { rule: 'claim_expiry', affected: result.modifiedCount };
}

/** Flags items nobody has touched in a while. Does not close anything. */
export async function markStale(
  store: Store,
  projectId: string,
  rules: HygieneRules,
  now: Date,
): Promise<HygieneOutcome> {
  if (rules.staleAfterHours === null) return { rule: 'stale', affected: 0 };
  const cutoff = hoursAgo(now, rules.staleAfterHours);
  const result = await store.items.updateMany(
    {
      projectId,
      status: { $nin: [...TERMINAL_STATUSES] },
      stale: { $ne: true },
      touchedAt: { $lte: cutoff },
    },
    [
      {
        $set: {
          ...appendTimeline(
            `no activity for ${rules.staleAfterHours}h, marked stale`,
            now,
          ),
          stale: true,
          staleSince: now,
        },
      },
    ],
  );
  return { rule: 'stale', affected: result.modifiedCount };
}

/**
 * Drops items that were opened and then abandoned without ever being
 * described: no body, no claim, and no timeline entry beyond the creation one.
 * A titled placeholder that nobody ever came back to is noise, and noise is
 * what makes agents stop reading the board.
 */
export async function dropContentless(
  store: Store,
  projectId: string,
  rules: HygieneRules,
  now: Date,
): Promise<HygieneOutcome> {
  if (rules.requireBodyAfterHours === null) return { rule: 'require_body', affected: 0 };
  const cutoff = hoursAgo(now, rules.requireBodyAfterHours);
  const result = await store.items.updateMany(
    {
      projectId,
      status: { $nin: [...TERMINAL_STATUSES] },
      body: '',
      claim: null,
      timelineCount: { $lte: 1 },
      createdAt: { $lte: cutoff },
    },
    [
      {
        $set: {
          ...appendTimeline(
            `no description within ${rules.requireBodyAfterHours}h and never touched again, dropped. Upsert the same slug with a body to bring it back.`,
            now,
          ),
          status: 'dropped',
          closedAt: now,
        },
      },
    ],
  );
  await releaseSlots(store, projectId, result.modifiedCount);
  return { rule: 'require_body', affected: result.modifiedCount };
}

/**
 * Closes mirrored items whose source signal has gone away.
 *
 * Both guards are mandatory and this is the expensive lesson from the board this replaced: a
 * count alone closes live tickets during a sync blip, and a clock alone closes
 * tickets whose source simply was not polled. The fix that finally worked was
 * "N consecutive absences AND at least M hours of continuous absence", and it
 * took half a year to arrive at. It ships as the default here.
 */
export async function resolveAbsent(
  store: Store,
  projectId: string,
  rules: HygieneRules,
  now: Date,
): Promise<HygieneOutcome> {
  if (rules.absenceResolve === null) return { rule: 'absence_resolve', affected: 0 };
  const { observations, minHours } = rules.absenceResolve;
  const cutoff = hoursAgo(now, minHours);
  const result = await store.items.updateMany(
    {
      projectId,
      source: { $ne: null },
      status: 'open',
      'absence.count': { $gte: observations },
      'absence.since': { $lte: cutoff },
    },
    [
      {
        $set: {
          ...appendTimeline(
            {
              $concat: [
                'source signal absent for ',
                { $toString: { $ifNull: ['$absence.count', 0] } },
                ` consecutive observations and over ${minHours}h, resolved automatically`,
              ],
            },
            now,
          ),
          status: 'done',
          closedAt: now,
        },
      },
    ],
  );
  await releaseSlots(store, projectId, result.modifiedCount);
  return { rule: 'absence_resolve', affected: result.modifiedCount };
}

/**
 * Repairs the open-item count if, and only if, nothing is writing right now.
 *
 * The count is maintained by exact increments on every path that changes it, so
 * this exists for the leftovers: a process that died between reserving a slot
 * and inserting, or an item edited straight in the database. The guard matters
 * more than the recount. A plain recompute-and-set clobbers concurrent
 * reservations with a stale number, which is how a cap silently stops holding;
 * writing only when the counter still reads what we read makes the repair skip
 * itself instead of corrupting a live project.
 */
/**
 * There is deliberately no recount.
 *
 * An earlier version repaired the capacity counters by counting the collection
 * and writing the result back. Every version of that idea lost: a write landing
 * between the count and the write-back makes the repair store a number that is
 * stale by exactly the change it missed, and a write landing just after makes
 * the same item count twice. Guarding it on a quiet window only moved the
 * failure to projects that are never quiet, which are the busy ones.
 *
 * The counters do not need repairing. Every path that changes them applies an
 * exact delta after its write has succeeded, so the only drift a crash can
 * produce is an undercount, and an undercount hands out slightly more room than
 * it should. That is the mistake worth making: a recount that overcounts turns
 * a working project into one that rejects its own valid work.
 */

export async function sweepProject(
  store: Store,
  project: Pick<ProjectDoc, '_id' | 'rules'>,
  now: Date = new Date(),
): Promise<HygieneOutcome[]> {
  const rules = project.rules;
  const outcomes: HygieneOutcome[] = [];
  outcomes.push(await expireClaims(store, project._id, now));
  outcomes.push(await resolveAbsent(store, project._id, rules, now));
  outcomes.push(await dropContentless(store, project._id, rules, now));
  outcomes.push(await markStale(store, project._id, rules, now));

  return outcomes;
}

const SWEEP_THROTTLE_MS = 60_000;

/**
 * Sweeps a project at most once a minute, whoever asks. The throttle is taken
 * atomically so a burst of concurrent agents produces one sweep, not twenty.
 * Returns null when another caller already holds the slot.
 */
export async function maybeSweep(
  store: Store,
  project: Pick<ProjectDoc, '_id' | 'rules'>,
  now: Date = new Date(),
): Promise<HygieneOutcome[] | null> {
  const claimed = await store.projects.findOneAndUpdate(
    {
      _id: project._id,
      $or: [
        { lastSweptAt: null },
        { lastSweptAt: { $lte: new Date(now.getTime() - SWEEP_THROTTLE_MS) } },
      ],
    },
    { $set: { lastSweptAt: now } },
    { projection: { _id: 1 } },
  );
  if (!claimed) return null;
  return sweepProject(store, project, now);
}
