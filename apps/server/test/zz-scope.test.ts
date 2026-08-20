import { test } from 'node:test';
import { startHarness, createProject, authed } from './helper.js';

test('sonda: ktore drzwi ostrzegaja o zakresie', async () => {
  const harness = await startHarness();
  const P = await createProject(harness);
  const H = { ...authed(P), 'content-type': 'application/json' };
  const post = (path: string, payload: unknown) =>
    harness.server.inject({ method: 'POST', url: `${P.api}${path}`, headers: H, payload: payload as object });

  await post('/agents', { handle: 'worker', description: 'ops', scope: ['ops:'] });
  await post('/items', { slug: 'errors:leak', title: 'cudzy obszar', actor: 'somebody' });

  const scoped = (body: unknown) => {
    const w = (body as { warnings?: string[] }).warnings ?? [];
    const hit = w.filter((line) => /scope/i.test(line));
    return hit.length ? hit[0]!.slice(0, 60) : 'CISZA';
  };

  const doors: [string, () => Promise<{ json(): unknown }>][] = [
    ['upsert pozycji', () => post('/items', { slug: 'errors:leak', body: 'poza zakresem', actor: 'worker' })],
    ['dopisanie notatki', () => post('/items/errors:leak/note', { actor: 'worker', note: 'byłem tu' })],
    ['zajecie karty', () => post('/items/errors:leak/claim', { agent: 'worker' })],
    ['heartbeat', () => post('/items/errors:leak/heartbeat', { agent: 'worker' })],
    ['ruch na tablicy', () => post('/items/errors:leak/move', { column: 'doing', actor: 'worker' })],
    ['zwolnienie', () => post('/items/errors:leak/release', { agent: 'worker' })],
    ['obserwacja', () => post('/items/errors:leak/observe', { agent: 'worker', note: 'patrze' })],
  ];
  for (const [name, call] of doors) {
    const res = await call();
    console.log(name.padEnd(20), scoped(res.json()));
  }
  await harness.stop();
});
