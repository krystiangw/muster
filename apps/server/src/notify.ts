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

/**
 * How long a claimed board has to be silent before its operator is told.
 *
 * Silent means nobody wrote: not an agent, not a person, not a move on the
 * page. Long enough that a fleet running nightly is not reported as dead, and
 * paired with hygiene's own judgement below, so this never fires on a board
 * that is simply finished.
 */
const QUIET_AFTER_MS = 24 * 60 * 60 * 1000;

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
  /**
   * Tells a person that an agent set a board up for them.
   *
   * The second thing that pushes, and the exception to the paragraph at the
   * top of this file is deliberate: an offer used to sit in a view its
   * recipient had never opened, so the only way they heard about it was the
   * agent telling them over some channel this service cannot see. A board
   * built for somebody who is never told about it is a board that expires.
   *
   * Still not a digest and still not per item: one message, when an agent
   * names an address, and nothing after it.
   */
  boardOffered(
    project: ProjectDoc,
    offer: { email: string; offeredBy?: string | undefined; note?: string | undefined },
  ): Promise<void>;
  /**
   * Boards that stopped moving, told once each.
   *
   * The case the rest of this file cannot cover: an agent in a crash loop
   * never files a question, because filing one is work and it is not getting
   * that far. Nothing asks for anything, so nothing is sent, and the board
   * goes quiet exactly when somebody most needs to know. This is the only
   * notice in the service that exists because nothing happened.
   *
   * Deliberately not a rule on the cards. The audit that produced this cut the
   * alternative, which was counting attempts and reopening items: "failed" is
   * not observable from here, an expired lease is evidence a process stopped
   * rather than that work failed, and reopening moves a status the agents own.
   * This writes to no card at all.
   */
  sweepQuiet(): Promise<number>;
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
          // What the agent wrote for this reader. skill.md asks for it in those
          // words, and the message that reaches them left it on the board.
          context: escalation.context ?? '',
          itemSlug: escalation.itemSlug ?? null,
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
        // After the provider said yes, and separate from the stamp above it.
        // That one is the throttle claim, taken before the send so that two
        // agents filing at once cannot both mail; it is not evidence that
        // anything left. A process that dies between the claim and the rollback
        // leaves the claim looking recent, and anything watching the mail path
        // from outside would read that as healthy.
        await store.projects
          .updateOne({ _id: project._id }, { $set: { escalationNoticeSentAt: now } })
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

    async boardOffered(project, offer) {
      try {
        const delivery = await mailer.sendBoardOffer(offer.email, {
          projectName: project.name,
          // Blank is absent, not a name. Both doors accept an empty handle and
          // nullish coalescing let it through, so the message opened with a
          // space and the word "created".
          agent: (offer.offeredBy ?? '').trim() === ''
            ? 'An agent'
            : offer.offeredBy!.trim().slice(0, 48),
          note: (offer.note ?? '').slice(0, 500),
          readUrl: `${config.baseUrl}/r/${project.readToken}`,
          expiresInDays: config.demoTtlDays,
        });
        if (delivery !== 'sent') {
          log(`board offer for ${project._id} was ${delivery}, not sent`);
        }
      } catch (error) {
        // Never fails the call that caused it. The offer is recorded either
        // way, and it is waiting in the operator view of anybody who already
        // uses this service; the message is what makes it reach the people who
        // do not, and a provider having a bad minute is not a reason to refuse
        // an agent's write.
        log(`board offer for ${project._id} failed: ${(error as Error).message}`);
      }
    },

    async sweepMissed() {
      const now = new Date();
      const missedSince = new Date(now.getTime() - MISSED_AFTER_MS);
      // Open, never answered, and nobody was ever told. Grouped by project
      // because the throttle is per project: one message covers whatever that
      // board has accumulated.
      const hourAgo = new Date(now.getTime() - NOTIFY_EVERY_MS);
      // Eligibility is decided before the batch is cut, not after. A slot spent
      // on a project nobody owns, or one still inside its hour, is a slot an
      // eligible project does not get, and since neither entry goes away the
      // same twenty could crowd out the same somebody for ever.
      const due = await store.escalations
        .aggregate<{ _id: string; oldest: EscalationDoc; project: ProjectDoc }>([
          {
            $match: {
              status: 'open',
              createdAt: { $lte: missedSince },
              $or: [{ notifiedAt: null }, { notifiedAt: { $exists: false } }],
            },
          },
          { $sort: { createdAt: 1 } },
          { $group: { _id: '$projectId', oldest: { $first: '$$ROOT' } } },
          {
            $lookup: { from: 'projects', localField: '_id', foreignField: '_id', as: 'project' },
          },
          { $unwind: '$project' },
          {
            $match: {
              'project.claimedBy': { $ne: null },
              $or: [
                { 'project.escalationNotifiedAt': null },
                { 'project.escalationNotifiedAt': { $exists: false } },
                { 'project.escalationNotifiedAt': { $lt: hourAgo } },
              ],
            },
          },
          { $limit: REMINDER_BATCH },
        ])
        .toArray();

      let sent = 0;
      for (const entry of due) {
        // Read again on its turn. Twenty provider calls can take a while, and
        // a question answered in the meantime must not produce a message
        // asking somebody to answer it.
        const still = await store.escalations.findOne({ _id: entry.oldest._id, status: 'open' });
        if (!still) continue;
        if (await notifyOnce(entry.project, still as EscalationDoc)) sent += 1;
      }
      return sent;
    },
    async sweepQuiet() {
      const now = new Date();
      const quietSince = new Date(now.getTime() - QUIET_AFTER_MS);
      const hourAgo = new Date(now.getTime() - NOTIFY_EVERY_MS);

      // Candidates first, cheaply: a board with an owner and something on it.
      // Oldest notice first, so a busy deployment cycles rather than telling
      // the same twenty projects for ever.
      const candidates = await store.projects
        .find({ claimedBy: { $ne: null }, 'counts.items': { $gt: 0 } })
        .sort({ quietNotifiedAt: 1 })
        .limit(REMINDER_BATCH)
        .toArray();

      let sent = 0;
      for (const project of candidates) {
        // A question notice in the last hour means this operator has already
        // heard from us about this board, and a second message in the same
        // hour is how a useful notice becomes one people filter. Checked and
        // deliberately not stamped: a real question filed a minute from now
        // must not be delayed by this pass having looked.
        const told = project.escalationNotifiedAt;
        if (told && told > hourAgo) continue;

        // Anybody at all, agent or person: `touchedAt` is the write that says
        // somebody is on this, and hygiene deliberately does not move it, so a
        // board being tidied by the engine still reads as quiet.
        const moved = await store.items.countDocuments(
          { projectId: project._id, touchedAt: { $gte: quietSince } },
          { limit: 1 },
        );
        if (moved > 0) continue;

        const [open, stale, newest] = await Promise.all([
          store.items.countDocuments({ projectId: project._id, status: 'open' }, { limit: 500 }),
          store.items.countDocuments(
            { projectId: project._id, status: 'open', stale: true },
            { limit: 500 },
          ),
          store.items
            .find({ projectId: project._id }, { projection: { touchedAt: 1 } })
            .sort({ touchedAt: -1 })
            .limit(1)
            .toArray(),
        ]);
        // Two conditions, not one. Silence alone is a board somebody parked;
        // silence with work hygiene has already marked as rotting is the shape
        // a stopped fleet leaves behind, and the threshold for stale is the
        // project's own setting rather than a number invented here.
        if (open === 0 || stale === 0) continue;

        const lastTouched = newest[0]?.touchedAt ?? project.createdAt;
        // One per quiet spell. Told already, and nothing has happened since
        // that message: saying it again adds nothing that was not true then.
        if (project.quietNotifiedAt && lastTouched <= project.quietNotifiedAt) continue;

        // The stamp is taken before the send and guarded on what we read, so
        // two dynos running this pass in the same minute produce one message.
        const claimed = await store.projects.findOneAndUpdate(
          { _id: project._id, quietNotifiedAt: project.quietNotifiedAt ?? null },
          { $set: { quietNotifiedAt: now } },
        );
        if (!claimed) continue;

        try {
          const isPrivate = (project.visibility ?? 'link') === 'owner';
          const delivery = await mailer.sendQuietBoard(project.claimedBy!, {
            projectName: project.name,
            open,
            stale,
            quietFor: Math.max(
              1,
              Math.round((now.getTime() - lastTouched.getTime()) / (60 * 60 * 1000)),
            ),
            readUrl: isPrivate
              ? `${config.baseUrl}/operator`
              : `${config.baseUrl}/r/${project.readToken}`,
          });
          if (delivery === 'sent') sent += 1;
          else log(`quiet notice for ${project._id} was ${delivery}, not sent`);
        } catch (error) {
          // The stamp goes back, guarded on our own claim, so a provider
          // having a bad minute does not cost this board its one message.
          await store.projects
            .updateOne(
              { _id: project._id, quietNotifiedAt: now },
              { $set: { quietNotifiedAt: project.quietNotifiedAt ?? null } },
            )
            .catch(() => undefined);
          log(`quiet notice for ${project._id} failed: ${(error as Error).message}`);
        }
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
