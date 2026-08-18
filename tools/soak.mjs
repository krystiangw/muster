/**
 * Randomised concurrent workload against a live Muster, checking the invariants
 * that unit tests cannot: that the open-item counter matches reality, that a
 * slug never becomes two items, and that two agents never hold one claim.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:4600';
const AGENTS = ['errors-loop', 'trades-loop', 'pm-loop', 'system-loop', 'scoring-loop'];
const SLUGS = Array.from({ length: 25 }, (_, i) => `soak:item-${i}`);
const ROUNDS = Number(process.argv[2] ?? 400);

const created = await (
  await fetch(`${BASE}/p`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'soak' }),
  })
).json();

const headers = { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' };
const api = `${BASE}/v1/${created.project}`;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const call = (path, method, body) =>
  fetch(`${api}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))
    .catch((error) => ({ status: 0, body: { error: String(error) } }));

for (const handle of AGENTS) {
  await call('/agents', 'POST', { handle, scope: [] });
}

const counters = {
  upsert: 0,
  claim: 0,
  close: 0,
  reopen: 0,
  note: 0,
  release: 0,
  move: 0,
  observe: 0,
  ask: 0,
  answer: 0,
  error: 0,
};
const errors = [];
// Questions this run filed, so the answers below aim at something real. Kept as
// a list rather than a count because answering one twice is a case worth
// hitting: the accounting has to treat a repeat as one decision.
const asked = [];

const operations = [
  async (agent) => {
    const r = await call('/items', 'POST', {
      slug: pick(SLUGS),
      title: 'soak item',
      body: 'a body',
      actor: agent,
      source: Math.random() < 0.4 ? 'scanner' : undefined,
    });
    if (r.status >= 400 && r.body.error !== 'limit_reached') errors.push(r.body);
    counters.upsert += 1;
  },
  async (agent) => {
    const r = await call(`/items/${pick(SLUGS)}/claim`, 'POST', { agent, ttl_minutes: 1 });
    if (r.status >= 400 && r.status !== 409 && r.status !== 404) errors.push(r.body);
    counters.claim += 1;
  },
  async (agent) => {
    const r = await call(`/items/${pick(SLUGS)}/release`, 'POST', { agent });
    if (r.status >= 400 && r.status !== 409 && r.status !== 404) errors.push(r.body);
    counters.release += 1;
  },
  async (agent) => {
    const r = await call('/items', 'POST', { slug: pick(SLUGS), status: 'done', actor: agent });
    if (r.status >= 400 && r.body.error !== 'limit_reached') errors.push(r.body);
    counters.close += 1;
  },
  async (agent) => {
    const r = await call('/items', 'POST', { slug: pick(SLUGS), status: 'open', actor: agent });
    if (r.status >= 400 && r.body.error !== 'limit_reached') errors.push(r.body);
    counters.reopen += 1;
  },
  async (agent) => {
    const r = await call(`/items/${pick(SLUGS)}/timeline`, 'POST', { actor: agent, message: 'note' });
    if (r.status >= 400 && r.status !== 404) errors.push(r.body);
    counters.note += 1;
  },
  async (agent) => {
    // A move is several writes behind one request, which is exactly the shape
    // that goes wrong under concurrency; the invariants below cover it too.
    const column = pick(['todo', 'doing', 'blocked', 'done']);
    const r = await call(`/items/${pick(SLUGS)}/move`, 'POST', { column, actor: agent });
    if (r.status >= 400 && ![404, 409].includes(r.status) && r.body.error !== 'limit_reached') {
      errors.push(r.body);
    }
    counters.move += 1;
  },
  async () => {
    const present = SLUGS.filter(() => Math.random() < 0.5);
    const r = await call('/observe', 'POST', { source: 'scanner', present });
    if (r.status >= 400) errors.push(r.body);
    counters.observe += 1;
  },
  // The other counter with a cap on it, and the other pair of writes that has
  // to agree with a collection: a question charges a slot, an answer gives it
  // back, and reopening takes it again.
  async (agent) => {
    const r = await call('/escalations', 'POST', { agent, question: 'is this thing on?' });
    if (r.status >= 400 && r.body.error !== 'limit_reached') errors.push(r.body);
    if (r.body.escalation) asked.push(r.body.escalation.id);
    counters.ask += 1;
  },
  async () => {
    if (asked.length === 0) return;
    const id = pick(asked);
    const status = pick(['answered', 'resolved', 'wont_do', 'open']);
    const r = await call(`/escalations/${id}`, 'PATCH', { status, answer: 'because' });
    if (r.status >= 400 && r.body.error !== 'limit_reached') errors.push(r.body);
    counters.answer += 1;
  },
];

const start = performance.now();
for (let round = 0; round < ROUNDS; round += 1) {
  await Promise.all(
    Array.from({ length: 8 }, () => {
      const agent = pick(AGENTS);
      return pick(operations)(agent);
    }),
  );
}
const elapsed = performance.now() - start;

// Let one sweep run, then compare the counter with the collection.
await call('/sweep', 'POST');
const summary = await (await fetch(`${api}`, { headers })).json();
const items = (await (await fetch(`${api}/items?limit=200`, { headers })).json()).items;

const escalations = (await (await fetch(`${api}/escalations?limit=200`, { headers })).json()).escalations ?? [];
const openQuestions = escalations.filter((escalation) => escalation.status === 'open');
const open = items.filter((item) => item.status !== 'done' && item.status !== 'dropped');
const slugs = new Set(items.map((item) => item.slug));
// A claim still attached to an item after its own expiry means the sweep never
// released it, which is the failure that blocks work behind a dead session.
const expiredClaims = items.filter(
  (item) => item.claim && new Date(item.claim.expires_at) < new Date(),
);

console.log(`${ROUNDS * 8} operations in ${(elapsed / 1000).toFixed(1)}s`, counters);
console.log('items stored          :', items.length, '(unique slugs:', slugs.size, ')');
console.log('open items counted    :', summary.counts.items);
console.log('open items in reality :', open.length);
console.log('open questions counted:', summary.counts.escalations);
console.log('open questions really :', openQuestions.length);
console.log('unexpected errors     :', errors.length, errors.slice(0, 3));

const problems = [];
if (items.length !== slugs.size) problems.push('a slug became more than one item');
if (summary.counts.items !== open.length) problems.push('counter disagrees with the collection');
if (summary.counts.items < 0) problems.push('counter went negative');
if (summary.counts.escalations !== openQuestions.length) {
  problems.push('question counter disagrees with the collection');
}
if (summary.counts.escalations < 0) problems.push('question counter went negative');
if (expiredClaims.length > 0) {
  problems.push(`${expiredClaims.length} claim(s) outlived their expiry and were never released`);
}
if (errors.length > 0) problems.push('unexpected errors');

console.log(problems.length === 0 ? '\nOK: every invariant held.' : `\nPROBLEMS: ${problems.join('; ')}`);
process.exit(problems.length === 0 ? 0 : 1);
