import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createStore } from './db.js';
import { sweepProject } from './hygiene.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 50;

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await createStore(config.mongoUri, config.mongoDb);
  const { server, limiter } = await buildApp(config, store);

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
    })();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    limiter.stop();
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await server.listen({ port: config.port, host: config.host });
  server.log.info({ baseUrl: config.baseUrl }, 'muster is up');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
