import { connectStore } from '../src/db.js';
const uri = process.env.MONGODB_URI!;
const store = await connectStore(uri, process.env.MONGODB_DB ?? 'muster');
const projects = await store.projects.find({}).toArray();
console.log('PROJECTS TOTAL:', projects.length);
const rows: any[] = [];
for (const p of projects as any[]) {
  const items = await store.items.find({ projectId: p._id }).toArray();
  const byStatus: Record<string, number> = {};
  const prefixes = new Set<string>();
  for (const it of items as any[]) {
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    if (String(it.slug).includes(':')) prefixes.add(String(it.slug).split(':')[0]);
  }
  const agents = await store.agents.countDocuments({ projectId: p._id });
  rows.push({
    id: p._id, name: p.name, slug: p.slug ?? null, alias: p.alias ?? null,
    created: p.createdAt?.toISOString?.() ?? String(p.createdAt),
    claimedBy: p.claimedBy ? String(p.claimedBy).replace(/(.{2}).*@/, '$1***@') : null,
    visibility: p.visibility, items: items.length, byStatus, agents,
    prefixes: [...prefixes].sort(),
    desc: (p.description ?? '').slice(0, 120),
  });
}
rows.sort((a, b) => b.items - a.items);
for (const r of rows) {
  console.log(`${String(r.items).padStart(4)} items | ${String(r.agents).padStart(2)} agents | ${r.id} | ${r.name} | vis=${r.visibility} | claimed=${r.claimedBy ?? '-'} | created=${r.created}`);
  console.log(`        status=${JSON.stringify(r.byStatus)} prefixes=${JSON.stringify(r.prefixes)}`);
  if (r.desc) console.log(`        desc="${r.desc}"`);
}
// agent handles across boards
const agents = await store.agents.find({}).toArray();
const byHandle: Record<string, string[]> = {};
for (const a of agents as any[]) {
  (byHandle[a.handle] ??= []).push(String(a.projectId));
}
console.log('\nAGENT HANDLES ACROSS BOARDS:');
for (const [h, ps] of Object.entries(byHandle).sort((a,b)=>b[1].length-a[1].length)) {
  console.log(`  ${h}: ${ps.length} board(s) -> ${ps.join(', ')}`);
}
// operator identities across boards
console.log('\nCLAIMED-BY across boards:');
const byOwner: Record<string, string[]> = {};
for (const p of projects as any[]) if (p.claimedBy) (byOwner[String(p.claimedBy)] ??= []).push(String(p._id));
for (const [o, ps] of Object.entries(byOwner)) console.log(`  ${o.replace(/(.{2}).*@/, '$1***@')}: ${ps.length} -> ${ps.join(', ')}`);
process.exit(0);
