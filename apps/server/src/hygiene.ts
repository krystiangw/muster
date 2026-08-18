import type { Store } from './db.js';
import { TERMINAL_STATUSES, type HygieneRules, type ProjectDoc } from './types.js';

/**
 * The hygiene engine.
 *
 * Every rule here exists because a real board rotted without it. The reference
 * failures were measured on the board this one replaces: 506 frozen tickets,
 * 63 items left unroutable by an enum drift, and a handover that claimed 56
 * shipped features when the database held two.
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
  /**
   * Items a rule took a flag *off*, when it has such a case. Separate from
   * `affected`, because one number covering both directions would report a
   * pass that unmarked three items as having marked three.
   */
  unmarked?: number;
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

/**
 * Flags items nobody has touched in a while. Does not close anything.
 *
 * An item under a live claim is exempt, and that is not a courtesy. A
 * heartbeat deliberately does not move `touchedAt`, because it is not a write
 * of anything: it says "still on it", not "here is what I learned". Without
 * the exemption, an agent that holds an item longer than the stale window and
 * heartbeats it correctly the whole time watches the board flag its work as
 * rotten, which is the board lying about the one thing it is for. The moment
 * the lease lapses the exemption goes with it, and `touchedAt` is already old,
 * so the item is marked on the very next sweep.
 */
export async function markStale(
  store: Store,
  projectId: string,
  rules: HygieneRules,
  now: Date,
): Promise<HygieneOutcome> {
  // The repair runs first and unconditionally. A project that has since turned
  // the rule off can still be carrying flags from when it was on, and those
  // are exactly the ones nothing else will ever clear.
  // Undo what this rule got wrong before the exemption existed. Hygiene
  // marks and agents unmark, so a rule that clears its own flag is a departure
  // worth naming: it is this rule correcting its own past output, on items
  // where the correction can never come from anywhere else. A heartbeat writes
  // neither `stale` nor `touchedAt`, and releasing the claim does not clear a
  // flag either, so without this a card marked once under a live claim carries
  // it for as long as the item exists.
  const repaired = await store.items.updateMany(
    {
      projectId,
      stale: true,
      'claim.expiresAt': { $gt: now },
    },
    [
      {
        $set: {
          ...appendTimeline(
            'somebody holds this, so the stale flag was cleared: it was marked before held work was exempt',
            now,
          ),
          stale: false,
          staleSince: null,
        },
      },
    ],
  );

  if (rules.staleAfterHours === null) {
    return {
      rule: 'stale',
      affected: 0,
      ...(repaired.modifiedCount > 0 ? { unmarked: repaired.modifiedCount } : {}),
    };
  }
  const cutoff = hoursAgo(now, rules.staleAfterHours);

  const result = await store.items.updateMany(
    {
      projectId,
      status: { $nin: [...TERMINAL_STATUSES] },
      stale: { $ne: true },
      touchedAt: { $lte: cutoff },
      $or: [{ claim: null }, { 'claim.expiresAt': { $lte: now } }],
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
  return {
    rule: 'stale',
    // Both directions in one number would say "stale: 3" for a pass that
    // unmarked three, so the repair is counted where it belongs.
    affected: result.modifiedCount,
    ...(repaired.modifiedCount > 0 ? { unmarked: repaired.modifiedCount } : {}),
  };
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
 * Both guards are mandatory, and this is the expensive lesson from the board
 * this one replaces: a count alone closes live tickets during a sync blip, and
 * a clock alone closes
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
          // The second way an item gets closed, and it used to leave the claim
          // behind. An agent then held a lease on finished work until it timed
          // out, and any column asking for `claimed: true` showed a done card
          // as in progress. The ordinary close has released it since the
          // audits; this one is the same act by a different hand.
          claim: null,
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
 * Corrects an overcounted project, and only ever downwards.
 *
 * Full reconciliation kept losing: recounting a collection while it is being
 * written to stores a number that is stale by exactly the change it missed, and
 * a write landing just after the count makes the same item count twice. Both
 * mistakes point the same way, at a counter that is too high, and a counter
 * that is too high makes a working project reject its own valid work.
 *
 * So this only ever lowers a counter, and only to a number it has actually
 * seen. If a concurrent create lands right after the count, the write-back
 * misses it and the project is briefly one slot generous, which nobody notices.
 * If a process died between closing an item and giving back its slot, the
 * overcount is repaired within a minute instead of lasting forever.
 */
export async function correctOvercount(store: Store, projectId: string): Promise<boolean> {
  // The counter is read before the count and used as the guard afterwards. A
  // create landing while we count changes it, the guard stops matching and the
  // repair skips itself. Without that, the repair would overwrite the new
  // increment with a number taken before it existed, and since it never raises
  // a counter, that undercount would be permanent.
  const before = await store.projects.findOne({ _id: projectId }, { projection: { counts: 1 } });
  if (!before) return false;

  // Stamped before the count, checked after it. Closing an item is two writes,
  // the status and then the slot, and the counter still reads the old number in
  // between: a repair that counted in that gap saw one item fewer than the
  // counter, matched its guard, wrote the lower number, and then the close's
  // own decrement took it one lower still. CI found the counter at -1 from
  // exactly that. The counter guard cannot see it, because at that instant the
  // counter genuinely is what the repair read; what moved was an item.
  const mark = new Date();
  const [openItems, openEscalations] = await Promise.all([
    store.items.countDocuments({ projectId, status: { $nin: [...TERMINAL_STATUSES] } }),
    store.escalations.countDocuments({ projectId, status: 'open' }),
  ]);
  const [itemsMoved, escalationsMoved] = await Promise.all([
    store.items.countDocuments({ projectId, updatedAt: { $gte: mark } }),
    store.escalations.countDocuments({ projectId, updatedAt: { $gte: mark } }),
  ]);
  if (itemsMoved > 0 || escalationsMoved > 0) return false;

  const repairs = await Promise.all([
    before.counts.items > openItems
      ? store.projects.updateOne(
          { _id: projectId, 'counts.items': before.counts.items },
          { $set: { 'counts.items': openItems } },
        )
      : Promise.resolve({ modifiedCount: 0 }),
    before.counts.escalations > openEscalations
      ? store.projects.updateOne(
          { _id: projectId, 'counts.escalations': before.counts.escalations },
          { $set: { 'counts.escalations': openEscalations } },
        )
      : Promise.resolve({ modifiedCount: 0 }),
  ]);
  return repairs.some((repair) => repair.modifiedCount > 0);
}

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
  await correctOvercount(store, project._id);
  // After the rules, never before them. `lastSweptAt` is the throttle claim and
  // maybeSweep takes it on the way in, so it advances even on a pass where
  // every rule throws; a watcher asking whether hygiene still works needs the
  // date a sweep reached the end.
  //
  // Stamped here rather than from `now`, which is when this pass started and on
  // a slow one is minutes behind. `$max` because a scheduled pass and one a
  // request triggered can overlap: whichever finishes second must not hand the
  // watchdog an older date than the one already recorded.
  await store.projects.updateOne({ _id: project._id }, { $max: { sweptAt: new Date() } });

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
