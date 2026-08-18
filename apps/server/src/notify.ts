import type { Store } from './db.js';
import type { Config } from './config.js';
import type { Mailer } from './email.js';
import type { EscalationDoc, ProjectDoc } from './types.js';

/**
 * The part that makes "ask the human" mean something.
 *
 * Everything else in this server is pull: an agent writes, and a person finds
 * out the next time they open the page. That is the right default for items,
 * which are a record, and the wrong one for escalations, which are a stop. An
 * agent that stops at three in the morning stays stopped until somebody
 * happens to look, and the whole promise of the escalation is that it does not
 * have to.
 *
 * So exactly one thing pushes, and only to the address that claimed the
 * project. No digests, no per-item mail, nothing to an address that never
 * asked for it.
 */

/**
 * One message per project per hour, whatever is filed in between.
 *
 * Per project rather than per operator: two projects going quiet for different
 * reasons are two different problems, and collapsing them buys a quieter inbox
 * at the price of the second one arriving an hour late. Per hour rather than
 * per question: an agent in a loop can file a question a minute, and a person
 * who is asleep will not read sixty of them any better than one.
 */
const NOTIFY_EVERY_MS = 60 * 60 * 1000;

/**
 * How long a question waits before the periodic pass counts it as missed.
 *
 * Long enough that a notice already on its way is not raced, short enough that
 * a question filed inside somebody else's hour still reaches a person while
 * the agent that asked it is plausibly still around.
 */
const MISSED_AFTER_MS = 10 * 60 * 1000;

/** How many projects one periodic pass will look after. */
const REMINDER_BATCH = 20;

export interface Notifier {
  escalationRaised(project: ProjectDoc, escalation: EscalationDoc): Promise<void>;
  /**
   * The questions the hourly throttle swallowed.
   *
   * The immediate notice is one per project per hour, which is right for a
   * burst and wrong for the question that lands inside another question's
   * hour: nothing is sent, and the only record is a page nobody has open. This
   * runs on a timer, finds questions nobody was ever told about, and sends one
   * message per project naming the oldest of them. Every question is covered
   * by exactly one message, and no project gets more than one an hour, so
   * repairing the hole does not turn into a nag.
   */
  sweepMissed(): Promise<number>;
}

export function createNotifier(deps: {
  store: Store;
  config: Config;
  mailer: Mailer;
  log: (message: string) => void;
}): Notifier {
  const { store, config, mailer, log } = deps;

  const notifier: Notifier = {
    async escalationRaised(project, escalation) {
      const now = new Date();
      let before: ProjectDoc | null = null;
      try {
        // The throttle is the write itself, not a check before one. Two agents
        // filing in the same second both read "last notified: never" if this
        // were a read followed by a write, and both would send. Here the
        // loser's update matches nothing and returns null.
        //
        // Inside the try with everything else: the question is already filed by
        // the time this runs, so a database hiccup here must not turn a
        // successful write into a 500 that invites the agent to file it twice.
        before = await store.projects.findOneAndUpdate(
          {
            _id: project._id,
            claimedBy: { $ne: null },
            $or: [
              { escalationNotifiedAt: { $exists: false } },
              { escalationNotifiedAt: null },
              { escalationNotifiedAt: { $lt: new Date(now.getTime() - NOTIFY_EVERY_MS) } },
            ],
          },
          { $set: { escalationNotifiedAt: now } },
          { returnDocument: 'before' },
        );
        if (!before?.claimedBy) return;

        const waiting = await store.escalations.countDocuments({
          projectId: project._id,
          status: 'open',
        });
        // A project narrowed to its owner answers the read link with a 404 to
        // any browser without their session, which is every phone they have
        // not signed in on. Sending that link would be sending them a dead
        // one, so a private project gets pointed at the door it can open.
        const isPrivate = (before.visibility ?? 'link') === 'owner';
        const delivery = await mailer.sendEscalation(before.claimedBy, {
          projectName: before.name,
          agent: escalation.agent,
          question: escalation.question,
          // The count is read after the insert, so it already includes this
          // question; a project whose count says zero is one whose escalation
          // was answered in the microsecond in between, and one is the honest
          // floor for a message that exists because of this question.
          waiting: Math.max(waiting, 1),
          readUrl: isPrivate ? `${config.baseUrl}/operator` : `${config.baseUrl}/r/${before.readToken}`,
          operatorUrl: `${config.baseUrl}/operator`,
          needsSignIn: isPrivate,
        });
        if (delivery === 'discarded') {
          // Nothing left the building: no provider is configured, and the
          // message carried a link so it was not written to the log either.
          // Holding the hour on the strength of that would suppress every
          // question filed in it, including the ones after somebody fixes the
          // configuration.
          throw new Error('no mail provider configured, the notice was discarded');
        }
        if (delivery !== 'sent') {
          log(`escalation notice for ${project._id} was ${delivery}, not sent`);
        }
        // Only the one this message named. The others keep waiting to be
        // mentioned by name, which is what the periodic pass is for: a count
        // in somebody else's message is not being told about your question.
        await store.escalations
          .updateOne({ _id: escalation._id }, { $set: { notifiedAt: now } })
          .catch(() => undefined);
      } catch (error) {
        // An hour of silence is a worse failure than a duplicate message, so a
        // send that threw gives the hour back. Guarded on our own stamp: if a
        // later question has already claimed the window, that one is the live
        // notification and this must not disturb it.
        await store.projects
          .updateOne(
            { _id: project._id, escalationNotifiedAt: now },
            { $set: { escalationNotifiedAt: before?.escalationNotifiedAt ?? null } },
          )
          .catch(() => undefined);
        log(`escalation notice for ${project._id} failed: ${(error as Error).message}`);
      }
    },

    async sweepMissed() {
      const now = new Date();
      const missedSince = new Date(now.getTime() - MISSED_AFTER_MS);
      // Open, never answered, and nobody was ever told. Grouped by project
      // because the throttle is per project: one message covers whatever that
      // board has accumulated.
      const projects = await store.escalations
        .aggregate<{ _id: string; oldest: EscalationDoc }>([
          {
            $match: {
              status: 'open',
              createdAt: { $lte: missedSince },
              $or: [{ notifiedAt: null }, { notifiedAt: { $exists: false } }],
            },
          },
          { $sort: { createdAt: 1 } },
          { $group: { _id: '$projectId', oldest: { $first: '$$ROOT' } } },
          { $limit: REMINDER_BATCH },
        ])
        .toArray();

      let sent = 0;
      for (const entry of projects) {
        const project = await store.projects.findOne({ _id: entry._id });
        if (!project?.claimedBy) continue;
        if (await notifyOnce(project, entry.oldest)) sent += 1;
      }
      return sent;
    },
  };

  return notifier;

  /**
   * Whether a message actually left, which the periodic pass needs and the
   * request path does not: an agent filing a question does not wait to hear
   * whether the operator's mail provider was reachable. The stamp is the
   * evidence, because only the send path writes it.
   */
  async function notifyOnce(project: ProjectDoc, escalation: EscalationDoc): Promise<boolean> {
    await notifier.escalationRaised(project, escalation);
    const stamped = await store.escalations.countDocuments({
      _id: escalation._id,
      notifiedAt: { $ne: null },
    });
    return stamped > 0;
  }
}
