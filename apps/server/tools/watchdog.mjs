#!/usr/bin/env node
/**
 * Notices that production stopped answering, and says so somewhere else.
 *
 * Two things this has to get right, and both are lessons the hygiene engine
 * already learned the hard way:
 *
 *  - **The alert cannot travel through the thing it watches.** Filing an
 *    escalation on the board is useless when the board is what is down, so the
 *    alert is an email, sent through the mail provider, which shares nothing
 *    with the dyno or the database. Filing on the board happens too, best
 *    effort, because a partial outage is the common case and the note belongs
 *    with the work.
 *  - **Two guards, never one.** A single failed request is a blip, and paging
 *    somebody for a blip teaches them to ignore the pager. It alerts on the
 *    second consecutive failure, and only once per outage.
 *
 * What it checks is deliberately not `/health`: that route answers without
 * touching the database, so it stays green through exactly the failure that
 * matters most. It reads a real project through the API instead.
 *
 *   node apps/server/tools/watchdog.mjs            # one round, quiet unless it matters
 *   node apps/server/tools/watchdog.mjs --status   # what it thinks right now
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The operator's, unless a test says otherwise. A monitor nobody has watched
// fail is a cron entry, not a monitor, and the only thing standing between this
// script and a test was the one line that decided where its state lives.
const HOME = process.env.MUSTER_HOME || join(homedir(), '.muster');
const STATE = join(HOME, 'watchdog.state.json');
const TIMEOUT_MS = 15_000;
const ALERT_TO = process.env.MUSTER_ALERT_TO || 'gwizdala.kr@gmail.com';

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
// Defaults over the file, not instead of it: a state written by an older
// version of this script is missing whatever was added since, and undefined + 1
// is NaN, which counts as a miss forever and alerts never.
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
// Written before the backup check was split out of the outage latch, so its
// `alerted` could mean either "production is down" or "the archives are old",
// and there is no way to tell which from the file. Cleared rather than
// carried: the cost of clearing it wrongly is one repeated outage mail, and
// the cost of trusting it is the outage mail never going out at all.
const beforeTheSplit = saved.backupMisses === undefined;
const state = {
  failures: 0,
  alerted: false,
  lastOk: null,
  ...saved,
  ...(beforeTheSplit ? { alerted: false } : {}),
  // Read back through their own types rather than spread as they are: a state
  // written by an older version of this script has no counter at all, and
  // undefined + 1 is NaN, which JSON writes as null, counts as a miss forever
  // and alerts never.
  hygieneMisses: Number(saved.hygieneMisses) || 0,
  hygieneAlerted: saved.hygieneAlerted === true,
  noticeMisses: Number(saved.noticeMisses) || 0,
  noticeAlerted: saved.noticeAlerted === true,
  backupMisses: Number(saved.backupMisses) || 0,
  backupAlerted: saved.backupAlerted === true,
  lastNote: typeof saved.lastNote === 'string' ? saved.lastNote : null,
  keyCheckedAt: typeof saved.keyCheckedAt === 'string' ? saved.keyCheckedAt : null,
  keyAlerted: saved.keyAlerted === true,
};

if (process.argv.includes('--status')) {
  console.log(JSON.stringify(state, null, 1));
  process.exit(0);
}

const tokens = JSON.parse(read(join(HOME, 'tokens.json')) ?? '{}');
const [projectId, entry] = Object.entries(tokens)[0] ?? [];
if (!projectId) {
  console.error('No project in ~/.muster/tokens.json, so there is nothing to read as a check.');
  process.exit(1);
}
const base = entry.base;

async function probe(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      // Named on every request, so a quarter-hourly check does not read as a
      // quarter-hourly stranger in a report about strangers.
      headers: { 'user-agent': 'muster-selftest watchdog/1.0', ...(options.headers ?? {}) },
      signal: controller.signal,
    });
    const body = options.json
      ? await response.json().catch(() => null)
      : options.text
        ? await response.text().catch(() => null)
        : null;
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: String(error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// The page a person lands on, and a read that has to reach the database. Either
// one failing is an outage worth knowing about.
const checks = [
  { name: 'landing', ...(await probe(`${base}/`)) },
  {
    name: 'api read',
    ...(await probe(`${base}/v1/${projectId}`, {
      headers: { authorization: `Bearer ${entry.token}` },
      json: true,
    })),
  },
];

/**
 * Can a person still submit a form on their own board?
 *
 * Nothing above answers that. Every check here speaks the way an agent does,
 * with a bearer token and no browser headers, and the check a browser has to
 * pass is a different one: on 2026-08-18 our own referrer policy blanked the
 * Origin header, the same-site check read that as a stranger, and every form on
 * the capability pages answered 403 for a night while all of this stayed green.
 *
 * The probe writes nothing. An unknown status word is refused after the link
 * has been recognised and before anything is answered, so 400 means the whole
 * path in front of the write is open: same-site check, read token, visibility.
 *
 * A board narrowed to its owner is the exception, and only that one. It answers
 * 404 to anybody without the owner's session cookie, which this has no way to
 * hold, so on a private board 404 is the healthy answer and requiring 400 would
 * page about a button on the operator's own page. On a board open by link it is
 * not healthy at all: it means the route or the read link stopped resolving
 * while everything else stayed green, which is the same kind of silent breakage
 * this check exists for. An older deployment that does not report `visibility`
 * gets the benefit of the doubt rather than a page.
 */
const summary = checks.find((check) => check.name === 'api read')?.body;
const readUrl = summary?.read_url;
// A closed set, so a healthy answer has to be named rather than merely not be
// a 403. Everything else, a 500 or a timeout included, is a miss.
const formOpen = summary?.visibility === undefined || summary.visibility === 'owner' ? [400, 404] : [400];
if (readUrl) {
  const form = await probe(`${readUrl}/escalations/e_watchdog_probe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // What a browser sends from one of our own pages, and what the check has
      // to accept. Not curl's absent headers, which pass by a different rule.
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    },
    body: 'status=watchdog-probe',
  });
  checks.push({
    name: 'browser form',
    ok: formOpen.includes(form.status),
    status: form.status || form.error,
  });
}

/**
 * Does the board still carry the code it says it carries?
 *
 * Every check above is answered by the server rendering HTML, and until this
 * week that was the whole product. It is not any more: the fields on a board
 * become lists somebody can arrow through, and a card can be dragged, and all
 * of that lives in one file the page names in a script tag. A deploy that
 * shipped the page without the file, or shipped a page pointing at the previous
 * build's file, leaves every check here green while the board quietly loses the
 * half of itself that only a browser sees. That is this monitor's whole subject.
 *
 * The assertion costs nothing and knows nothing about what the script says,
 * because the URL is the file's own name: the path carries the first twelve hex
 * of the sha256 of the body it serves. Hashing what came back and comparing it
 * to what it was fetched as proves three things at once, that the page names a
 * script, that the script is served, and that the two came out of the same
 * build. Coupling the check to any string inside the script would instead make
 * it fail the next time somebody edits a comment.
 */
if (readUrl) {
  const page = await probe(`${readUrl}/board`, { text: true });
  const named = /\/board-([0-9a-f]{12})\.js/.exec(page.body ?? '');
  let script = { ok: false, why: 'the board page names no script' };
  // A board narrowed to its owner answers 404 to anybody without the owner's
  // session cookie, which this has no way to hold. The same exception the form
  // probe above makes, and for the same reason: on that board there is no page
  // for a stranger to read, so there is no script tag to check and demanding
  // one would page about the board being private.
  if (page.status === 404 && formOpen.includes(404)) {
    script = { ok: true, why: 'not open by link' };
  } else if (page.status !== 200) {
    script = { ok: false, why: `board page ${page.status || page.error}` };
  } else if (named) {
    const served = await probe(`${base}${named[0]}`, { text: true });
    const digest =
      served.status === 200 && served.body !== null
        ? createHash('sha256').update(served.body).digest('hex').slice(0, 12)
        : null;
    script =
      digest === named[1]
        ? { ok: true, why: named[1] }
        : { ok: false, why: digest === null ? `script ${served.status || served.error}` : `page wants ${named[1]}, server serves ${digest}` };
  }
  checks.push({ name: 'board script', ok: script.ok, status: script.why });
}

/**
 * Is anything still writing the backups?
 *
 * The one failure in this system that leaves every other check green. The cron
 * entry runs on this machine, not on the dyno, so nothing the service reports
 * has any bearing on it: a laptop asleep at the wrong hour, a moved file, a
 * revoked disk permission, and the archives simply stop, quietly, until the day
 * somebody needs one. `docs/deploy.md` already says to test the restore rather
 * than the backup, and the restore was drilled by hand against the newest
 * archive on 2026-08-19. What was missing is the cheaper half: noticing that
 * there is no newest archive any more.
 *
 * Two nights rather than one, for the same reason the outage rule needs two
 * failures: one missed run is a laptop that was closed, two is something that
 * stopped.
 */
const BACKUP_MAX_AGE_HOURS = 48;
let backupAge = null;
let backupsFresh = false;
{
  const dir = join(HOME, 'backups');
  let newest = null;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json.gz')) continue;
      const at = statSync(join(dir, name)).mtimeMs;
      if (newest === null || at > newest) newest = at;
    }
  }
  // Compared raw and rounded only to say it out loud. Rounding first moves the
  // boundary half an hour early, and with a backup at 03:17 and this running
  // every quarter of an hour, the round just before 03:17 on the second night
  // would page about a run that had not had its turn yet.
  const ageMs = newest === null ? null : Date.now() - newest;
  backupAge = ageMs === null ? null : ageMs / 3_600_000;
  // Decided once. The line that says it and the branch that acts on it were
  // each comparing for themselves, so one of them could be changed and the
  // other would go on disagreeing quietly.
  backupsFresh = backupAge !== null && backupAge < BACKUP_MAX_AGE_HOURS;
  checks.push({
    name: 'backups',
    ok: backupsFresh,
    // Local, so it stays out of the outage latch below. A stale archive on this
    // laptop is not production being down, and letting it set `alerted` would
    // silence the outage mail this whole script exists to send.
    local: true,
    status:
      backupAge === null
        ? 'no archive in ~/.muster/backups'
        : `newest is ${Math.round(backupAge)}h old`,
  });
}

// Production only. The backup check reports beside these and is answered on its
// own terms further down, because it is about this machine.
const broken = checks.filter((check) => !check.ok && !check.local);
const now = new Date().toISOString();

// One place the credential comes from, and an override, so the check below can
// be shown failing without moving the only copy of the real one.
const alertKey = process.env.MUSTER_RESEND_KEY || read(join(HOME, 'resend.key'));

async function mail(subject, lines) {
  const key = alertKey;
  if (!key) return 'no key';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': 'muster-watchdog/1.0',
    },
    body: JSON.stringify({
      from: 'Muster watchdog <hello@musterboard.dev>',
      to: [ALERT_TO],
      subject,
      text: lines.join('\n'),
    }),
  });
  return response.ok ? 'sent' : `failed ${response.status}`;
}

/** Best effort, and never allowed to break the round. */
async function fileOnTheBoard(question, context) {
  try {
    const response = await fetch(`${base}/v1/${projectId}/escalations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${entry.token}`,
        'content-type': 'application/json',
        'user-agent': 'muster-selftest watchdog/1.0',
      },
      body: JSON.stringify({ agent: 'watchdog', question, context, priority: 'urgent' }),
    });
    return response.ok ? 'filed' : `refused ${response.status}`;
  } catch {
    return 'unreachable, which is the point';
  }
}

/**
 * One line an hour when nothing is wrong.
 *
 * "Quiet unless it matters" was the rule, and it left a log that is empty when
 * this runs every quarter of an hour and equally empty when the cron entry is
 * gone: the two states a person tailing the file most wants to tell apart. The
 * date in the state file is the machine readable version and nobody opens it.
 *
 * Hourly rather than every round, so a day is twenty four lines and each one
 * carries what was actually checked, which makes the file a record of how the
 * deployment behaved rather than a heartbeat with no content.
 */
const NOTE_EVERY_MS = 60 * 60_000;
const noteIsDue = () =>
  state.lastNote === null || Date.parse(now) - Date.parse(state.lastNote) >= NOTE_EVERY_MS;
// Written at the end of the round rather than when the HTTP checks pass, so a
// line saying everything is fine cannot be printed above an alert from the same
// round, and cannot claim the hour on a round that had something to say.
let hygieneBehind = false;
let noticesStuck = false;
let backupsStale = false;
// Anything this round already said, recoveries included. A round that printed
// "hygiene is running again" has reported itself, and following that with a
// line claiming nothing happened would both repeat it and take the hour from
// the next quiet round.
let said = false;
const say = (line) => {
  said = true;
  console.log(line);
};

if (broken.length === 0) {
  const recovered = state.alerted;
  Object.assign(state, { failures: 0, alerted: false, lastOk: now });
  if (recovered) {
    const delivery = await mail('Muster is answering again', [
      `${base} is back up as of ${now}.`,
      '',
      'The watchdog will stay quiet until something else breaks.',
    ]);
    say(`recovered, told you: ${delivery}`);
  }
} else {
  state.failures += 1;
  const detail = broken.map((c) => `${c.name}: ${c.status || c.error}`).join('; ');
  // The second consecutive miss, not the first. One failed request is weather.
  if (state.failures >= 2 && !state.alerted) {
    const delivery = await mail('Muster is not answering', [
      `${base} failed ${state.failures} checks in a row.`,
      '',
      detail,
      '',
      `Last seen healthy: ${state.lastOk ?? 'not since this watchdog started'}.`,
      '',
      'heroku logs -n 100 -a muster-web',
      'heroku ps -a muster-web',
    ]);
    const filed = await fileOnTheBoard(
      'Production stopped answering. Is this a deploy in progress or a real outage?',
      `${detail}. Last healthy ${state.lastOk ?? 'unknown'}.`,
    );
    state.alerted = true;
    say(`down: ${detail} | email ${delivery} | board ${filed}`);
  } else {
    say(`miss ${state.failures}: ${detail}`);
  }
}

/**
 * The other way this service fails: it keeps answering, and stops tidying.
 *
 * Hygiene runs on a five minute timer inside the dyno, plus a throttled pass on
 * request. If the timer dies, nothing goes red: claims stay held forever, items
 * stop going stale, and the board looks exactly like a board with nothing to
 * tidy. `swept_at` is the difference between those two, so the check is its
 * age, and the alert goes on the board rather than to the pager, because the
 * service is up and the escalation mail is already throttled per project.
 *
 * The date is written when a sweep finishes, not when one starts, which is why
 * this can be read straight out of a request that triggers a sweep of its own:
 * a pass that throws moves the throttle marker and leaves this alone.
 *
 * An hour is six passes. It is generous on purpose: a deployment sweeping more
 * projects than one batch holds takes several passes to come round again, and
 * the number to raise then is the batch size, not this.
 */
const HYGIENE_MAX_AGE_MS = 60 * 60_000;
const apiRead = checks.find((check) => check.name === 'api read');
// Absent is not the same as null. A deployment older than the field says
// nothing about its hygiene, and a watchdog that reads silence as a symptom
// would file an escalation about a version difference.
if (broken.length === 0 && apiRead?.body && 'swept_at' in apiRead.body) {
  const sweptAt = apiRead.body.swept_at ? new Date(apiRead.body.swept_at) : null;
  const ageMs = sweptAt ? Date.parse(now) - sweptAt.getTime() : null;
  const behind = ageMs === null || ageMs > HYGIENE_MAX_AGE_MS;
  if (!behind) {
    if (state.hygieneAlerted) say('hygiene is running again');
    state.hygieneMisses = 0;
    state.hygieneAlerted = false;
  } else {
    hygieneBehind = true;
    state.hygieneMisses += 1;
    const since = sweptAt ? `${Math.round(ageMs / 60_000)} min ago` : 'never';
    if (state.hygieneMisses >= 2 && !state.hygieneAlerted) {
      const filed = await fileOnTheBoard(
        'Hygiene has stopped running. Is the sweeper dead, or is the deployment sweeping more projects than it can reach?',
        `${projectId} was last swept ${since}, and the service is answering normally. `
          + 'Claims will not expire and nothing will be marked stale until it runs again. '
          + 'heroku restart -a muster-web is the blunt fix; the sweeper is the interval in apps/server/src/index.ts.',
      );
      // Latched only once something actually left. A refused filing is exactly
      // when the alert matters, and marking it sent would silence the only
      // channel there is until hygiene fixes itself. The mail is the fallback
      // because it shares nothing with the dyno or the database.
      const delivery = filed === 'filed' ? 'not needed' : await mail('Muster stopped tidying', [
        `${projectId} was last swept ${since}, and ${base} is answering normally.`,
        '',
        'Claims will not expire and nothing will be marked stale until hygiene runs again.',
        `Filing this on the board was refused: ${filed}.`,
        '',
        'heroku restart -a muster-web',
      ]);
      state.hygieneAlerted = filed === 'filed' || delivery === 'sent';
      say(
        `hygiene behind: last swept ${since} | board ${filed} | email ${delivery}`
          + (state.hygieneAlerted ? '' : ' | nothing landed, will try again'),
      );
    } else {
      say(`hygiene miss ${state.hygieneMisses}: last swept ${since}`);
    }
  }
}

/**
 * The failure that is not the service's at all.
 *
 * The archives are the only copy that exists, and the cron that writes them
 * runs on this machine rather than on the dyno, so a laptop asleep at the wrong
 * hour stops them while every check above stays green. Answered here, on its
 * own counter, rather than in the outage branch: a stale archive is not
 * production being down, and letting it hold the outage latch would silence the
 * mail this whole script exists to send, on the night it was needed.
 *
 * The board is the first channel because production is up by definition when
 * this reads, and mail is the fallback, the same order the hygiene check uses
 * and for the same reason.
 */
// Only while production is answering, the same gate the hygiene branch uses.
// During an outage this would file on a board that is very likely down and
// send mail saying the service is answering normally, and the filing has no
// timeout of its own, so it would sit in front of writing the outage latch.
if (broken.length > 0) {
  // Nothing said and nothing counted: an outage is not evidence either way
  // about the archives, and counting a miss here would reach two on a bad
  // afternoon rather than after two nights.
} else if (backupsFresh) {
  if (state.backupAlerted) say('backups are being written again');
  state.backupMisses = 0;
  state.backupAlerted = false;
} else if (backupAge !== null || existsSync(join(HOME, 'tokens.json'))) {
  backupsStale = true;
  state.backupMisses += 1;
  const since = backupAge === null ? 'never, or not where this looks' : `${Math.round(backupAge)}h ago`;
  if (state.backupMisses >= 2 && !state.backupAlerted) {
    const filed = await fileOnTheBoard(
      'Nothing has written a backup for two nights. Is the cron still installed on the machine that runs it?',
      `The newest archive in ~/.muster/backups is ${since}, and the service is answering normally. `
        + 'The free Atlas tier takes no snapshots, so these files are the only copy that exists. '
        + 'crontab -l should show the muster-backup line; the log is ~/.muster/logs/backup.log.',
    );
    const delivery = filed === 'filed' ? 'not needed' : await mail('Muster has stopped backing up', [
      `The newest archive in ~/.muster/backups is ${since}, and ${base} is answering normally.`,
      '',
      'The free Atlas tier takes no snapshots, so these files are the only copy that exists.',
      `Filing this on the board was refused: ${filed}.`,
      '',
      'crontab -l | grep muster-backup',
      'tail -n 40 ~/.muster/logs/backup.log',
    ]);
    state.backupAlerted = filed === 'filed' || delivery === 'sent';
    say(
      `backups stale: newest ${since} | board ${filed} | email ${delivery}`
        + (state.backupAlerted ? '' : ' | nothing landed, will try again'),
    );
  } else {
    say(`backup miss ${state.backupMisses}: newest ${since}`);
  }
}

/**
 * The third way this service fails quietly: it answers, it tidies, and nothing
 * it writes ever leaves the building.
 *
 * The whole product is "an agent stops and asks a human". If the mail provider
 * refuses every send, the questions pile up on a board nobody has open and the
 * agents wait, which is exactly what happened on 2026-08-17 for a different
 * reason and cost fourteen hours.
 *
 * Two dates tell the two silences apart, and one of them alone tells neither.
 * The mail is throttled to one message per project per hour, so a queue waiting
 * its turn has an old unannounced question and a recent `notice_sent_at`: the
 * hourly message keeps moving even while the back of the queue waits. A dead
 * mail path has both of them old. Two hours is generous against both the hourly
 * throttle and the ten minute pass that picks up whatever the throttle missed.
 *
 * The alert goes on the board first and only falls back to mail, which is the
 * reverse of every other check here, for the obvious reason: mail is the thing
 * under suspicion. A board nobody reads is still a better record than a message
 * that was never sent.
 */
const NOTICE_STUCK_MS = 2 * 60 * 60_000;
if (broken.length === 0 && apiRead?.body && 'oldest_unannounced_at' in apiRead.body) {
  const summary = apiRead.body;
  const oldestMs = summary.oldest_unannounced_at ? Date.parse(summary.oldest_unannounced_at) : null;
  const lastNoticeMs = summary.notice_sent_at ? Date.parse(summary.notice_sent_at) : null;
  // Only a claimed board has an address to write to. On an unclaimed one every
  // question is unannounced for ever, and that is the design rather than a
  // fault.
  const waiting =
    summary.claimed === true && oldestMs !== null && Date.parse(now) - oldestMs > NOTICE_STUCK_MS;
  const silent = lastNoticeMs === null || Date.parse(now) - lastNoticeMs > NOTICE_STUCK_MS;
  if (!(waiting && silent)) {
    if (state.noticeAlerted) say('notices are going out again');
    state.noticeMisses = 0;
    state.noticeAlerted = false;
  } else {
    noticesStuck = true;
    state.noticeMisses += 1;
    const waitedMin = Math.round((Date.parse(now) - oldestMs) / 60_000);
    const lastNotice = lastNoticeMs
      ? `${Math.round((Date.parse(now) - lastNoticeMs) / 60_000)} min ago`
      : 'never';
    if (state.noticeMisses >= 2 && !state.noticeAlerted) {
      const filed = await fileOnTheBoard(
        'Nothing has been mailed to the operator for two hours while a question waits. Is the mail provider refusing us?',
        `The oldest unannounced question on ${projectId} has waited ${waitedMin} min, and the last `
          + `notice for this project went out ${lastNotice}. The service is answering normally, so `
          + 'this is the mail path, not the dyno. Check the provider key and the sending domain: '
          + 'heroku logs -a muster-web | grep "escalation notice".',
      );
      const delivery = filed === 'filed' ? 'not needed' : await mail('Muster is not mailing anybody', [
        `The oldest unannounced question on ${projectId} has waited ${waitedMin} min.`,
        `The last notice for this project went out ${lastNotice}, and ${base} is answering normally.`,
        '',
        `Filing this on the board was refused: ${filed}.`,
      ]);
      state.noticeAlerted = filed === 'filed' || delivery === 'sent';
      say(
        `notices stuck: oldest waited ${waitedMin} min, last notice ${lastNotice} | board ${filed} | email ${delivery}`
          + (state.noticeAlerted ? '' : ' | nothing landed, will try again'),
      );
    } else {
      say(`notice miss ${state.noticeMisses}: oldest waited ${waitedMin} min, last notice ${lastNotice}`);
    }
  }
}

/**
 * Whether the alarm can still ring, asked without ringing it.
 *
 * Every alert above ends in a mail, and the credential that sends it is a
 * secret on this laptop. A key that has been rotated or revoked costs nothing
 * until the night it is needed, and then costs this whole file. Finding the
 * file is not the same as the provider still accepting what is in it.
 *
 * A body with no recipient is what asks. The provider authenticates before it
 * validates the shape, so 422 means the credential is good and nothing left
 * the machine. Daily, because a key does not rot in an hour, and reported on
 * the board rather than by mail, because mail is the thing under suspicion.
 */
const KEY_CHECK_EVERY_MS = 24 * 60 * 60_000;
const keyCheckIsDue = () =>
  state.keyCheckedAt === null || Date.parse(now) - Date.parse(state.keyCheckedAt) >= KEY_CHECK_EVERY_MS;

if (broken.length === 0 && keyCheckIsDue()) {
  const answer = alertKey
    ? await probe('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${alertKey}`, 'content-type': 'application/json' },
        body: '{}',
      })
    : { status: 0 };
  // Three answers, not two. 422 is the credential working. 401 and 403 are the
  // provider saying it does not know this key, which is the thing worth waking
  // somebody for. Everything else, a 429 or a 500 or a request that never
  // arrived, is the provider having a bad minute and says nothing about the
  // key: treating that as a revocation would page about somebody else's blip.
  // An inconclusive round does not spend the day's check either, so the next
  // round asks again instead of waiting until tomorrow.
  const rejected = answer.status === 401 || answer.status === 403 || !alertKey;
  if (answer.status === 422) {
    state.keyCheckedAt = now;
    if (state.keyAlerted) say('the alerting key is accepted again');
    state.keyAlerted = false;
  } else if (rejected) {
    state.keyCheckedAt = now;
    if (!state.keyAlerted) {
      const verdict = alertKey ? `answered ${answer.status}` : 'is not on disk';
      const filed = await fileOnTheBoard(
        'The key this watchdog alerts with is no longer accepted, so an outage would be silent.',
        `A request the provider answers with 422 when the credential is good ${verdict}. Nothing `
          + 'was sent. Rotate ~/.muster/resend.key and RESEND_API_KEY on the dyno together, because '
          + 'production sends every claim code and every escalation notice with the same one.',
      );
      state.keyAlerted = filed === 'filed';
      say(`the alerting key ${verdict} | board ${filed}`);
    }
  }
}

if (broken.length === 0 && !hygieneBehind && !noticesStuck && !backupsStale && !said && noteIsDue()) {
  state.lastNote = now;
  const swept = apiRead?.body?.swept_at
    ? `${Math.round((Date.parse(now) - Date.parse(apiRead.body.swept_at)) / 60_000)} min`
    : 'unknown';
  console.log(
    `ok ${now} ${checks.map((check) => `${check.name} ${check.status}`).join(', ')}, swept ${swept} ago`,
  );
}

mkdirSync(HOME, { recursive: true });
writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });
