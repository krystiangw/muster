import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * The protocol document, executed.
 *
 * `skill.md` is what an agent reads instead of documentation, so every curl in
 * it is a promise about a route that exists and a body this service accepts.
 * Nothing checked that. The tests around it check that the file is served,
 * that its links resolve and that it names the right package; the commands
 * inside it were prose.
 *
 * That mattered the moment unknown fields stopped being silently deleted: a
 * documented body carrying a field no schema has used to work by accident and
 * would now be refused, and the first person to find out would be a stranger
 * copying the first example on the page.
 *
 * What is asserted is deliberately narrow. A documented call may legitimately
 * answer 409, because several examples demonstrate a refusal on purpose: the
 * guarded write that loses its race, the successor that is already filed. What
 * it may never answer is 400, 404 or 405, which are the three ways of saying
 * "that is not a call this service has".
 */
let harness: Harness;

/** Codes this deployment would have emailed, newest last. */
const posted: string[] = [];

before(async () => {
  // The signup document ends in a claim, and a claim is two calls with a
  // six digit code in between. Without a mailer the first of them answers 503
  // and the second can only be run against a guess, which tests the guess.
  harness = await startHarness(
    {},
    {
      mailer: {
        sendClaimCode: async (_to, code) => {
          posted.push(code);
          return 'sent';
        },
        sendOperatorCode: async () => 'sent',
        sendBoardOffer: async () => 'sent',
        sendQuietBoard: async () => 'sent',
        sendEscalation: async () => 'sent',
      },
    },
  );
});

after(async () => {
  await harness.stop();
});

interface Command {
  method: string;
  url: string;
  body?: string;
}

/** The curl commands in a markdown document, in the order it prints them. */
export function commandsIn(markdown: string): Command[] {
  const found: Command[] = [];
  // Continuations first: a command written over four lines with backslashes is
  // one command, and the document writes most of them that way.
  const joined = markdown.replace(/\\\n\s*/g, ' ');
  // Then by command rather than by line, because one body is a JSON object
  // printed over three lines with no continuations at all: splitting on
  // newlines cut it in half and the test reported that the service refuses its
  // own documented example.
  const chunks = joined.split(/\n(?=curl )/).flatMap((part) => {
    const at = part.indexOf('curl ');
    return at === -1 ? [] : [part.slice(at)];
  });
  for (const chunk of chunks) {
    const text = chunk.split(/\n```/)[0]!.trim();
    if (!text.startsWith('curl ')) continue;
    // `-sX POST` is how the document writes it, so the flag is not `-X` on its
    // own: the first version of this read every command as a GET and reported
    // that the signup route does not exist.
    const method = /-[a-zA-Z]*X\s+([A-Z]+)/.exec(text)?.[1] ?? 'GET';
    // The URL is the first argument that looks like one, quoted or not.
    const url = /(?:"([^"]*\$MUSTER[^"]*)"|'([^']*\$MUSTER[^']*)'|(\$MUSTER\S*)|(https?:\/\/\S+))/.exec(
      text,
    );
    const target = url?.[1] ?? url?.[2] ?? url?.[3] ?? url?.[4];
    if (!target) continue;
    const body = /-d\s+'([\s\S]*?)'(?:\s|$)/.exec(text)?.[1];
    found.push({ method, url: target, ...(body ? { body } : {}) });
  }
  return found;
}

/**
 * Run one printed command and assert only what printing it promised.
 *
 * 409 is allowed on purpose, because several examples demonstrate a refusal;
 * so is a 404 that names `not_accepting`, which is a deployment declining
 * anonymous reports rather than a route that does not exist. Everything else
 * in 400, 404 and 405 means the document sent a reader somewhere this service
 * does not answer.
 */
async function runAsPrinted(
  command: Command,
  project: Project,
  fill: (text: string) => string,
): Promise<void> {
  const url = fill(command.url);
  const headers = url.startsWith('/v1/') ? authed(project) : { 'content-type': 'application/json' };
  const answer = await harness.server.inject({
    method: command.method as 'POST',
    url,
    headers,
    ...(command.body ? { payload: JSON.parse(fill(command.body)) } : {}),
  });
  const code = answer.statusCode === 404 ? String(answer.json().error ?? '') : '';
  if (code === 'not_accepting') return;
  assert.ok(
    ![400, 404, 405].includes(answer.statusCode),
    `${command.method} ${url} answered ${answer.statusCode}: ${answer.body.slice(0, 200)}`,
  );
}

describe('every curl the protocol prints', () => {
  it('reaches a route this service has, with a body it accepts', async () => {
    const project = await createProject(harness);
    const doc = (await harness.server.inject({ method: 'GET', url: '/skill.md' })).body;
    const commands = commandsIn(doc);
    assert.ok(commands.length >= 25, `the document has commands in it: found ${commands.length}`);

    const fill = (text: string): string =>
      text
        .replace('$MUSTER', project.api)
        .replace(harness.config.baseUrl, '')
        .replace('$HANDLE', 'errors-loop')
        .replace('$LAST_AS_OF', new Date().toISOString());

    let ran = 0;
    for (const command of commands) {
      // Placeholders the document tells the reader to fill in themselves. A
      // test that invented an escalation id would be testing its own guess.
      if (/[<>]/.test(command.url) || (command.body && /[<>]/.test(command.body))) continue;
      await runAsPrinted(command, project, fill);
      ran += 1;
    }
    assert.ok(ran >= 24, `most of the document is runnable as printed: ran ${ran}`);
  });

  it('runs the signup document too, including the claim it ends on', async () => {
    // Same promise, a different page, and the one a stranger reads first. Its
    // placeholders are angle brackets rather than shell variables, and the
    // printed code is a placeholder as well: six digits nobody can guess,
    // because only the server mints them.
    const project = await createProject(harness, 'signup-doc');
    const doc = (await harness.server.inject({ method: 'GET', url: '/agent-signup.md' })).body;
    const commands = commandsIn(doc);
    assert.ok(commands.length >= 4, `the signup document has commands in it: ${commands.length}`);

    const fill = (text: string): string =>
      text
        .replace(harness.config.baseUrl, '')
        .replace('<project>', project.id)
        .replace('<admin token>', project.token)
        .replace('<token>', project.token)
        .replace(/"code":\s*"\d{6}"/, `"code":"${posted.at(-1) ?? '000000'}"`);

    for (const command of commands) {
      await runAsPrinted(command, project, fill);
    }
    // Not "nothing answered 404": the two calls the document ends on are a
    // claim and its verification, so the project is owned afterwards or the
    // page walked a reader through a sequence that does not finish.
    assert.ok(posted.length > 0, 'the claim in the document actually asked for a code');
    const after = await harness.store.projects.findOne({ _id: project.id });
    assert.equal(after?.claimedBy, 'human@example.com', 'and the verification took');
  });

  it('signs up exactly as the first example on the page says', async () => {
    // The one command a stranger runs before anything else, taken from the
    // document rather than written here.
    const doc = (await harness.server.inject({ method: 'GET', url: '/agent-signup.md' })).body;
    const first = commandsIn(doc).find((command) => command.url.endsWith('/p'));
    assert.ok(first, 'the signup document opens with the signup');
    const answer = await harness.server.inject({
      method: first!.method as 'POST',
      url: first!.url.replace(harness.config.baseUrl, ''),
      headers: { 'content-type': 'application/json' },
      ...(first!.body ? { payload: JSON.parse(first!.body) } : {}),
    });
    assert.equal(answer.statusCode, 201);
    assert.ok(answer.json().token, 'and it hands back a token');
  });
});
