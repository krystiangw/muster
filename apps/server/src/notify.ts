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

export interface Notifier {
  escalationRaised(project: ProjectDoc, escalation: EscalationDoc): Promise<void>;
}

export function createNotifier(deps: {
  store: Store;
  config: Config;
  mailer: Mailer;
  log: (message: string) => void;
}): Notifier {
  const { store, config, mailer, log } = deps;

  return {
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
        if (delivery !== 'sent') {
          log(`escalation notice for ${project._id} was ${delivery}, not sent`);
        }
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
  };
}
