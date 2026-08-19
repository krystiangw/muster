import type { FastifyBaseLogger } from 'fastify';
import { flushEvents } from './events.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { ensureIndexes, openStore, runMigrations, storeUnreachable, type Store } from './db.js';
import { sweepProject } from './hygiene.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 50;
/** How long the port waits for a store that is probably already there. */
const READY_GRACE_MS = 10_000;

/**
 * Bring the store up behind the port, and keep trying.
 *
 * Connecting before listening meant a database blip during a deploy exited the
 * process, and Heroku backs a crashing dyno off for minutes: a database that
 * came back in twenty seconds still left the site down long after. Every route
 * already answers an unreachable store with 503 and `/health` says so, so the
 * honest thing is to serve that answer rather than not to serve at all.
 *
 * Indexes and migrations wait for the same connection, which is the point: a
 * process that started without them would otherwise run without them for ever.
 */
async function bringUp(store: Store, log: FastifyBaseLogger): Promise<void> {
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 30_000)) {
    try {
      await store.client.connect();
      await ensureIndexes(store);
      await runMigrations(store);
      store.ready = { ok: true, why: null };
      log.info('the store is up, with its indexes and migrations');
      return;
    } catch (error) {
      // Two different failures, and they deserve different words. A store that
      // cannot be reached will come back and this should keep asking. An index
      // that will not build, because the data already breaks the constraint it
      // is for, is a broken deployment: retrying it every thirty seconds for
      // ever changes nothing, and the only honest thing is to keep saying so
      // out loud while the routes that need it go on refusing.
      // The driver's own words stay in the log. A duplicate key error quotes
      // the value that was duplicated, which here can be a read link or an
      // operator's address, and `why` is read out by an endpoint anybody can
      // call: the public half says which of the two failures it is and
      // nothing else.
      const reachable = !storeUnreachable(error);
      store.ready = {
        ok: false,
        why: reachable
          ? 'the store connected but did not finish starting'
          : 'the database is not answering',
      };
      log[reachable ? 'error' : 'warn'](
        { err: error },
        reachable
          ? `the store connected and will not start; every board refuses until this is fixed, retrying in ${wait / 1000}s`
          : `the store is not answering; serving 503 and retrying in ${wait / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = openStore(config.mongoUri, config.mongoDb);
  const { server, limiter, notifier } = await buildApp(config, store);

  /**
   * The scheduled pass. Requests already trigger a throttled sweep of the
   * project they touch, so this exists for the projects nobody is touching:
   * a board goes quiet exactly when its claims are dangling and its items are
   * going stale, which is when hygiene matters most.
   */
  const sweeper = setInterval(() => {
    void (async () => {
      try {
        const stale = await store.projects
          .find({ 'counts.items': { $gt: 0 } })
          .sort({ lastSweptAt: 1 })
          .limit(SWEEP_BATCH)
          .toArray();
        let touched = 0;
        for (const project of stale) {
          const outcomes = await sweepProject(store, project);
          const changed = outcomes.reduce((sum, outcome) => sum + outcome.affected, 0);
          if (changed > 0) touched += changed;
          await store.projects.updateOne(
            { _id: project._id },
            { $set: { lastSweptAt: new Date() } },
          );
        }
        if (touched > 0) {
          server.log.info({ projects: stale.length, changes: touched }, 'hygiene sweep');
        }

      } catch (error) {
        server.log.error({ err: error }, 'hygiene sweep failed');
      }

      // Its own guard, deliberately. Sharing the one above meant a single
      // project whose sweep throws takes the notifications down with it, every
      // five minutes, silently: two unrelated jobs, two failures.
      try {
        // The other thing a quiet board cannot do for itself. A question filed
        // inside another question's hour is silently not sent, and the only
        // record of it is a page nobody has open; this is where it finally
        // reaches somebody.
        const told = await notifier.sweepMissed();
        if (told > 0) {
          server.log.info({ projects: told }, 'told somebody about questions that were missed');
        }
      } catch (error) {
        server.log.error({ err: error }, 'missed question sweep failed');
      }

      try {
        // Its own guard for the same reason as the two above: this one is
        // about boards where nothing is happening, and it must not be able to
        // take the notices about boards where something is.
        const quiet = await notifier.sweepQuiet();
        if (quiet > 0) {
          server.log.info({ projects: quiet }, 'told somebody their board stopped moving');
        }
      } catch (error) {
        server.log.error({ err: error }, 'quiet board sweep failed');
      }
    })();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    limiter.stop();
    await server.close();
    // Nothing on a request path waits for a recorded moment, so a dyno cycling
    // would otherwise drop the last few writes. Closing the client under them
    // would also log an error for something nobody was waiting on.
    await flushEvents();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Given a moment to finish before the port opens, because the ordinary
  // deploy takes about a quarter of a second and a 503 window nobody needed is
  // worse than a boot a quarter of a second slower. Only a moment, though: the
  // whole point is that a database which is not there cannot stop this
  // serving, and past this the same work carries on behind the port.
  const started = bringUp(store, server.log);
  await Promise.race([started, new Promise((resolve) => setTimeout(resolve, READY_GRACE_MS))]);
  void started;

  await server.listen({ port: config.port, host: config.host });
  server.log.info(
    { baseUrl: config.baseUrl, ready: store.ready.ok },
    store.ready.ok ? 'muster is up' : 'muster is up, and refusing boards until the store is',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
