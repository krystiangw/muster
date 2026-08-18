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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = join(homedir(), '.muster');
const STATE = join(HOME, 'watchdog.state.json');
const TIMEOUT_MS = 15_000;
const ALERT_TO = process.env.MUSTER_ALERT_TO || 'gwizdala.kr@gmail.com';

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
// Defaults over the file, not instead of it: a state written by an older
// version of this script is missing whatever was added since, and undefined + 1
// is NaN, which counts as a miss forever and alerts never.
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const state = {
  failures: 0,
  alerted: false,
  lastOk: null,
  ...saved,
  // Read back through their own types rather than spread as they are: a state
  // written by an older version of this script has no counter at all, and
  // undefined + 1 is NaN, which JSON writes as null, counts as a miss forever
  // and alerts never.
  hygieneMisses: Number(saved.hygieneMisses) || 0,
  hygieneAlerted: saved.hygieneAlerted === true,
  noticeMisses: Number(saved.noticeMisses) || 0,
  noticeAlerted: saved.noticeAlerted === true,
  lastNote: typeof saved.lastNote === 'string' ? saved.lastNote : null,
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
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = options.json ? await response.json().catch(() => null) : null;
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
const broken = checks.filter((check) => !check.ok);
const now = new Date().toISOString();

async function mail(subject, lines) {
  const key = read(join(HOME, 'resend.key'));
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
      headers: { authorization: `Bearer ${entry.token}`, 'content-type': 'application/json' },
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

if (broken.length === 0 && !hygieneBehind && !noticesStuck && !said && noteIsDue()) {
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
