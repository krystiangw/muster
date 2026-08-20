#!/usr/bin/env -S npx tsx
/**
 * What the service knows about how it is being used, printed to a terminal.
 *
 * Deliberately not a page. This is the operator of the service looking at their
 * own service, not a feature of it, and serving it would mean minting another
 * credential to protect it, on a product whose security notes are mostly about
 * how few of those there should be.
 *
 *   MONGODB_URI=... MONGODB_DB=muster npx tsx apps/server/tools/insights.mts
 *   MONGODB_URI="$(heroku config:get MONGODB_URI -a muster-web)" npx tsx apps/server/tools/insights.mts
 *
 * It lives under apps/server because that is where the Mongo driver is
 * installed; the tools at the repository root only ever speak HTTP.
 *
 * The funnel, the doors, the pages and the answer times come from `insights()`
 * in the service itself rather than from a second copy of those queries here.
 * There used to be two implementations, and they drifted exactly where it costs
 * most: the one with tests was right about which boards a funnel stage may
 * count, and the one the operator actually runs was the one printing six
 * hundred percent. What stays here is what does not belong in a library the
 * request path imports: an audit that counts every open item on the busiest
 * fifty boards is a job, not a getter.
 *
 * Reads only. It never writes, so running it against production is safe.
 */
import { connectStore } from '../src/db.js';
import { KEEP_DAYS, insights, isUnholdable } from '../src/events.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? 'muster';
if (!uri) {
  console.error('MONGODB_URI is not set. For production:');
  console.error(
    '  MONGODB_URI="$(heroku config:get MONGODB_URI -a muster-web)" npx tsx apps/server/tools/insights.mts',
  );
  process.exit(1);
}

// Not `createStore`: that one builds indexes and runs migrations, which is a
// server starting up rather than a report being read.
const store = await connectStore(uri, dbName);
const { events, projects, items } = store;
/** One reading of the clock for every window in this report. */
const now = new Date();
const since = (days: number) => new Date(now.getTime() - days * 86_400_000);

/**
 * When a board view stopped meaning somebody arrived.
 *
 * Until this deploy the page's own reload, once a minute, was recorded like any
 * other view, and there is no identity stored that could tell the two apart
 * afterwards. Measured before the fix: 3364 board views over two and a half
 * days, 35 per cent of them exactly a minute apart and 44 per cent between
 * eleven and forty seconds, which is what two or three tabs left open look like
 * when their cycles interleave. Whatever that number was measuring, it was not
 * people.
 *
 * So the count is printed on both sides of this moment rather than repaired.
 * Marking the old rows would mean guessing which of them was a person, and a
 * guess written into the data outlives the caveat that explains it.
 */
const REFRESH_MARKED_FROM = new Date('2026-08-20T06:05:00.000Z');

const [
  report,
  fileRows,
  arrivals,
  privateCount,
  weekSignups,
  weekWrites,
  moves,
  boardViews,
  viewsBeforeTheMark,
  weekViewsBeforeTheMark,
  movesSinceTheMark,
  unswept,
  oldestSweep,
] =
  await Promise.all([
    insights(store, now),
    events
      .aggregate<{ _id: string | null; n: number }>([
        { $match: { kind: 'discover' } },
        { $group: { _id: '$detail', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ])
      .toArray(),
    // Where visits came from, which is the one question our own counting could
    // not answer until the host was recorded beside the view. Hosts only: no
    // path and no query string ever reaches this log, so a search somebody
    // typed cannot be read out of it here or anywhere else.
    events
      .aggregate<{ _id: string; n: number }>([
        { $match: { kind: 'view', from: { $ne: null }, at: { $gte: since(30) } } },
        { $group: { _id: '$from', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 15 },
      ])
      .toArray(),
    projects.countDocuments({ visibility: 'owner' }),
    events.countDocuments({ kind: 'signup', at: { $gte: since(7) } }),
    // Boards that signed up in this window and wrote in it, not two counts of
    // two populations printed under one heading. Counted separately, "signups
    // that wrote" read six against one signup, which is the same mistake the
    // funnel above used to make, one section further down the page.
    events
      .aggregate<{ n: number }>([
        {
          $match: {
            kind: { $in: ['signup', 'first_write'] },
            projectId: { $ne: null },
            at: { $gte: since(7) },
          },
        },
        { $group: { _id: '$projectId', kinds: { $addToSet: '$kind' } } },
        { $match: { kinds: { $all: ['signup', 'first_write'] } } },
        { $count: 'n' },
      ])
      .toArray(),
    events.countDocuments({ kind: 'move' }),
    events.countDocuments({ kind: 'view', detail: 'board', at: { $gte: REFRESH_MARKED_FROM } }),
    events.countDocuments({ kind: 'view', detail: 'board', at: { $lt: REFRESH_MARKED_FROM } }),
    // The same artefact inside the seven day window, which is the number
    // printed directly under the row the caveat is attached to. It falls to
    // zero on its own once the cutoff is a week old, and the sentence goes
    // with it.
    events.countDocuments({
      kind: 'view',
      detail: 'board',
      at: { $gte: since(7), $lt: REFRESH_MARKED_FROM },
    }),
    events.countDocuments({ kind: 'move', at: { $gte: REFRESH_MARKED_FROM } }),
    // Hygiene, across every project rather than the one the watchdog reads: a
    // board nobody is sweeping looks exactly like a board with nothing to sweep.
    projects.countDocuments({
      'counts.items': { $gt: 0 },
      $or: [{ sweptAt: null }, { sweptAt: { $exists: false } }],
    } as never),
    projects
      .find({ 'counts.items': { $gt: 0 }, sweptAt: { $ne: null } } as never, {
        projection: { sweptAt: 1 },
      })
      .sort({ sweptAt: 1 })
      .limit(1)
      .toArray(),
  ]);

const rate = (part: number, whole: number) =>
  whole === 0 ? '  n/a' : `${((part / whole) * 100).toFixed(0).padStart(4)}%`;
const row = (label: string, value: string | number) =>
  console.log(`  ${label.padEnd(28)} ${String(value).padStart(7)}`);

console.log(`\nMuster, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n`);

const funnel = report.funnel;
const mine = report.ourOwn;
/** Two columns: strangers, then us, so neither can be mistaken for the other. */
const both = (label: string, theirs: number, ours: number): void =>
  console.log(`  ${label.padEnd(28)} ${String(theirs).padStart(7)} ${String(ours).padStart(9)}`);
console.log('The funnel, since events were first recorded');
// Said out loud, because the section below counts documents rather than
// events, and the two disagree by construction: a project claimed before this
// log existed is claimed on the board and absent from the funnel. Reading that
// as a contradiction is how somebody ends up "fixing" a number that is right.
console.log('  (events, not documents: anything that happened before this log started is missing)');
// Our own checks in their own column, never folded into the first one. The
// walkthrough signs up every week and the smoke tests register clients, and
// on the day this column was added thirteen of the seventeen boards in
// production were ours: a report about adoption that counts them is a report
// about us. Subtracting them silently would have been worse than leaving them
// in, because then nobody can tell whether the tools ran at all.
console.log(`  ${''.padEnd(28)} ${'strangers'.padStart(7)} ${'ours'.padStart(9)}`);
// What the date qualifies, in both directions, because it does not mean the
// same thing on both lines. A board that has said who it is counts as ours for
// its whole life, since the boards our tools reuse are older than the field. A
// read of the protocol carries no board and can never be attributed, so on the
// day this shipped the first column still held every read our own audits made.
// Saying only the first half would have been a confident wrong number, which
// is the thing this column exists to stop.
if (report.ourOwn.since === null) {
  console.log('  (nothing has been marked as ours yet, so the second column is empty rather than zero)');
} else {
  const day = report.ourOwn.since.toISOString().slice(0, 10);
  console.log(`  (marked as ours since ${day}: a board that has said who it is counts as ours from`);
  console.log('   its first day, but a read of the protocol carries no board, so earlier reads');
  console.log('   count as strangers until they age out)');
}
both('reads of the protocol', funnel.discovered, mine.discovered);
// Beside it, never inside it. One of these says whether the files are being
// indexed, the other says whether agents are reading them and walking away, and
// added together they answer the first question twice.
row('  and by crawlers, beside', funnel.discoveredByCrawlers);
both('created a project', funnel.signups, mine.signups);
both('  registered an agent', funnel.withAnAgent, mine.withAnAgent);
both('  wrote something', funnel.withWork, mine.withWork);
both('  claimed by a person', funnel.claimed, mine.claimed);
console.log(
  `  ${'reads per signup'.padEnd(28)} ${funnel.discovered === 0 ? '  n/a' : (funnel.discovered / Math.max(funnel.signups, 1)).toFixed(1).padStart(5)}`,
);
console.log(`  ${'signup -> wrote something'.padEnd(28)} ${rate(funnel.withWork, funnel.signups)}`);
console.log(`  ${'signup -> claimed'.padEnd(28)} ${rate(funnel.claimed, funnel.signups)}`);
// The boards the stages above cannot count, said out loud rather than left to
// be rediscovered as a contradiction. Events are kept ninety days, so a board
// that signed up before that is still writing here with nothing above it.
both('boards signed up before this', funnel.outsideWindow, mine.outsideWindow);
// Beside the funnel, not in it: asking is not a stage every claim passes
// through, and a stage that can exceed the one above it stops being believed.
// It exists because "nobody claimed one" has two explanations, and this tells
// them apart.
row('asked to be handed a board', report.handoverRequests);

const doorRows = Object.entries(report.doors).sort((a, b) => b[1] - a[1]);
if (doorRows.length > 0) {
  console.log('\nWhich door they came through');
  for (const [door, n] of doorRows) row(door, n);
}

if (fileRows.length > 0) {
  console.log('\nWhat they read');
  for (const { _id, n } of fileRows) row(_id ?? 'unknown', n);
}

// People, not agents. Crawlers are dropped where the view is recorded, and the
// two capability pages are counted by kind so no token ever reaches this log.
const pageRows = Object.entries(report.pages).sort((a, b) => b[1] - a[1]);
if (pageRows.length > 0) {
  console.log('\nPages people opened');
  for (const [page, n] of pageRows) {
    // The board is the one row here that was not people for most of its life,
    // and this is the line somebody reads first, so it says so where it is read
    // rather than four lines further down.
    if (page === 'board' && viewsBeforeTheMark > 0) {
      row(page, n);
      console.log(`  ${' '.repeat(28)} ${String(`of those, ${viewsBeforeTheMark} before the page's own reload stopped counting`).padStart(7)}`);
      continue;
    }
    row(page, n);
  }
  row('  in the last seven days', report.pagesLastWeek);
  if (weekViewsBeforeTheMark > 0) {
    console.log(
      `  ${' '.repeat(28)} ${String(`of those, ${weekViewsBeforeTheMark} are board views from before it`).padStart(7)}`,
    );
  }
  // The number that decides whether drag and drop was refused on evidence or
  // on taste. Above roughly three moves per board view, the refusal is wrong.
  //
  // Blind between 2026-08-17 09:37Z and 2026-08-18 06:55Z: `Referrer-Policy:
  // no-referrer` blanked the Origin on our own forms and the same-site check
  // refused every move posted in those twenty one hours. A zero covering that
  // window is a broken form, not a preference, and reading it as evidence is
  // how a feature gets refused twice for the same wrong reason.
  row('cards moved by hand', moves);
  // Both halves of this division have to come from the same side of the
  // moment the page's own reload stopped counting, or the ratio is a fix
  // divided by an artefact.
  row(
    '  per board view, since the reload stopped counting',
    boardViews === 0 ? 'no board views yet on this side of it' : (movesSinceTheMark / boardViews).toFixed(2),
  );
  row(
    '  board views before that, page reloads and all',
    `${viewsBeforeTheMark}, which is not a number of people`,
  );
}

// Names nobody can hold are dropped where the visit is recorded now, but two
// hundred are already stored and this table is where they were read as the
// largest source of traffic this service had. Counted and named as what they
// are rather than deleted: the visit happened, only the claim about where it
// came from was somebody's own audit.
const real = arrivals.filter((row) => !isUnholdable(String(row._id)));
const fromTests = arrivals
  .filter((row) => isUnholdable(String(row._id)))
  .reduce((sum, row) => sum + row.n, 0);
if (real.length > 0 || fromTests > 0) {
  console.log('\nWhere they came from, last 30 days');
  for (const { _id, n } of real) row(_id, n);
  if (fromTests > 0) {
    row('  arrivals naming a test host', `${fromTests}, not a site`);
  }
  if (real.length === 0) {
    console.log('  and nothing else named a source');
  }
} else {
  // Said out loud rather than left as an empty section: nothing here means
  // either nobody arrived from anywhere or every browser withheld the header,
  // and those are different situations.
  console.log('\nWhere they came from: nothing recorded in the last 30 days');
}

console.log('\nOn the boards right now');
row('projects', report.live.projects);
row('  of those, claimed', report.live.claimedProjects);
row('  of those, private', privateCount);
row('open items', report.live.openItems);
row('  of those, stale', report.live.staleItems);
row('agents', report.live.agents);
row('questions waiting', report.live.openQuestions);
const sweptAt = (oldestSweep[0] as { sweptAt?: Date } | undefined)?.sweptAt;
const sweepAgeMinutes = sweptAt ? Math.round((Date.now() - new Date(sweptAt).getTime()) / 60_000) : null;
row('longest since a sweep, min', sweepAgeMinutes === null ? 'n/a' : sweepAgeMinutes);
// Printed whether or not it is zero, like every count above it: a row that
// disappears when it is healthy leaves a reader unable to tell the healthy
// answer from a number nobody collected.
row('  boards never swept', unswept);

// Does the accounting agree with the work? The cap is enforced from the
// counter, so a counter that has drifted is a project quietly refusing work or
// quietly allowing too much of it. The repair fixes overcounts on its own; this
// says whether it is keeping up, and it is the only place an undercount shows
// at all.
//
// The candidates are chosen without looking at the number under audit. Picking
// them by the counter hid the very case worth finding: a counter that drifted
// to zero while work is still open would have been filtered out as an idle
// project. So both ends are asked, the boards with the most open work and the
// boards claiming the most, and every candidate is then counted exactly.
const CHECKED = 50;
// The one number that decides whether the search question gets reopened. The
// clock on a search bounds what a slow one costs; making the search itself
// cheap means changing what it matches, which docs/design-notes.md defers until
// a board is actually large. A trigger nobody measures is not a trigger, so it
// is measured here, where somebody reads it.
const REVISIT_SEARCH_AT = 50_000;
const [byWork, byCounter, largest] = await Promise.all([
  items
    .aggregate<{ _id: string; open: number }>([
      { $match: { status: { $nin: ['done', 'dropped'] } } },
      { $group: { _id: '$projectId', open: { $sum: 1 } } },
      { $sort: { open: -1 } },
      { $limit: CHECKED },
    ])
    .toArray(),
  projects
    .find({ 'counts.items': { $gt: 0 } } as never, { projection: { name: 1, counts: 1 } })
    .sort({ 'counts.items': -1 })
    .limit(CHECKED)
    .toArray(),
  // Everything a board holds, finished work included. The counter beside it
  // counts only what is open, which is the number the cap enforces and the
  // wrong one for this: a search reads what is stored.
  items
    .aggregate<{ _id: string; stored: number }>([
      { $group: { _id: '$projectId', stored: { $sum: 1 } } },
      { $sort: { stored: -1 } },
      { $limit: 1 },
    ])
    .toArray(),
]);
const candidateIds = [...new Set([...byWork.map((entry) => entry._id), ...byCounter.map((p) => p._id)])];
const candidates = await projects
  .find({ _id: { $in: candidateIds } }, { projection: { name: 1, counts: 1 } })
  .toArray();
const drifted: Array<{ name: string; open: number; counter: number }> = [];
for (const project of candidates) {
  const open = await items.countDocuments({
    projectId: project._id,
    status: { $nin: ['done', 'dropped'] },
  });
  if (open !== project.counts.items) {
    drifted.push({ name: project.name ?? project._id, open, counter: project.counts.items });
  }
}
row('counters checked', candidates.length);
row('  of those, drifted', drifted.length);
for (const entry of drifted.slice(0, 5)) {
  console.log(`    ${entry.name.slice(0, 24).padEnd(24)} counter ${entry.counter}, open ${entry.open}`);
}
const stored = largest[0]?.stored ?? 0;
row('largest board, items stored', stored);
if (stored >= REVISIT_SEARCH_AT) {
  console.log(`    past ${REVISIT_SEARCH_AT}: reopen the search question in docs/design-notes.md`);
}
row(
  'median answer, hours',
  report.behaviour.medianAnswerHours === null ? 'n/a' : report.behaviour.medianAnswerHours.toFixed(1),
);
if (report.behaviour.answersSampled > 0) {
  console.log(
    `  ${'  over the last'.padEnd(28)} ${String(report.behaviour.answersSampled).padStart(7)} answers`,
  );
}

// The mail sends people to the capability link, the operator page is where
// somebody who signed in ends up, and an agent's own operator can answer over
// the API. A door that is used and a door that is refused look identical from
// anywhere else, and the refused one is the one that gets removed for being
// unused. Both browser doors count as `browser`; which page it was is not worth
// a second field, since the question this settles is whether people answer from
// a browser at all.
const answerDoorRows = Object.entries(report.answerDoors).sort((a, b) => b[1] - a[1]);
if (answerDoorRows.length > 0) {
  console.log('\nHow the answers arrived');
  for (const [door, n] of answerDoorRows) row(door, n);
}

// Ordinarily zero, and printed whether or not it is: a browser refused as
// somebody else's page gets a page and tells nobody, and the agents never meet
// this check at all. `cross-site` and `origin` climbing together is somebody
// probing the forms; either one climbing while the boards are quiet is this
// service refusing pages it served itself, which is what it did for a night.
// `search_too_slow` is a different animal in the same list: a board that has
// outgrown a search that reads everything, which is the one number the search
// decision in docs/design-notes.md was deferred on.
const refusedRows = Object.entries(report.behaviour.refusedForms).sort((a, b) => b[1] - a[1]);
console.log('\nRefused, by reason');
row('all of them', refusedRows.reduce((total, [, n]) => total + n, 0));
for (const [reason, n] of refusedRows) row(`  ${reason}`, n);
// Printed at zero as well, unlike the rest, because this one is a trigger
// somebody wrote down and a row that is simply absent reads as unreported.
// Zero here is zero in the window these rows live in, not zero ever: they
// carry a TTL, so a search that hit the clock last spring has already been
// forgotten. Saying "never" would be this report making the same kind of
// claim the trigger exists to prevent.
if (!refusedRows.some(([reason]) => reason === 'search_too_slow')) {
  row('  search_too_slow', 0);
  console.log(`    none in the ${KEEP_DAYS} days these rows are kept, so the search question in docs/design-notes.md stays deferred`);
}

console.log('\nLast seven days');
row('signups', weekSignups);
row('  of those, wrote', weekWrites[0]?.n ?? 0);

if (report.busiestProjects.length > 0) {
  console.log('\nBusiest projects');
  for (const project of report.busiestProjects) {
    console.log(
      `  ${(project.name ?? project.project).slice(0, 28).padEnd(28)} ${String(project.items).padStart(7)} items, ${project.agents} agents`,
    );
  }
}

if (funnel.discovered === 0 && funnel.signups === 0) {
  console.log('\nNothing recorded yet. Events started on the release that added them,');
  console.log('so everything before that is invisible here and always will be.');
}

console.log();
await store.close();
