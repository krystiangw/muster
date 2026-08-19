import type { FastifyBaseLogger } from 'fastify';
import { flushEvents } from './events.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { ensureIndexes, openStore, runMigrations, type Store } from './db.js';
import { sweepProject } from './hygiene.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 50;

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
      log.info('the store is up, with its indexes and migrations');
      return;
    } catch (error) {
      log.error({ err: error }, `the store is not up; serving 503 and retrying in ${wait / 1000}s`);
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

  await server.listen({ port: config.port, host: config.host });
  server.log.info({ baseUrl: config.baseUrl }, 'muster is up');
  // After listening, deliberately: the port is what Heroku waits for, and a
  // database that takes a minute to answer must not become a boot timeout.
  void bringUp(store, server.log);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
