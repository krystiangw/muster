import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createProject, startHarness, type Harness } from './helper.js';

/**
 * The documents, executed.
 *
 * `skill.md` is what an agent reads instead of documentation, and the docs
 * pages are what a person copies from, so every curl printed on either is a
 * promise: this route exists, and this body is accepted. Nothing checked that.
 * The tests around them check that the files are served, that their links
 * resolve and that they name the right package; the commands inside them were
 * prose.
 *
 * That mattered the moment unknown fields stopped being silently deleted: a
 * documented body carrying a field no schema has used to work by accident and
 * would now be refused, and the first person to find out would be a stranger
 * copying the first example on the page.
 *
 * Two shapes of document, checked two ways. `skill.md` and `agent-signup.md`
 * are walkthroughs, so their commands run in order against the project their
 * own first command creates: that is what caught a move aimed at a card the
 * page never created. The docs pages are reference, organised by topic rather
 * than by sequence, so each command there runs against its own freshly seeded
 * project and is judged on its own.
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
  // The signup document ends in a claim, and a claim is two calls with a six
  // digit code in between. Without a mailer the first of them answers 503 and
  // the second can only be run against a guess, which tests the guess.
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

/** What `server.inject` hands back, without naming Fastify's own dependency. */
type Injected = Awaited<ReturnType<Harness['server']['inject']>>;

interface Command {
  method: string;
  url: string;
  body?: string;
}

/** The curl commands in a document, in the order it prints them. */
export function commandsIn(text: string): Command[] {
  const found: Command[] = [];
  // Continuations first: a command written over four lines with backslashes is
  // one command, and the documents write most of them that way.
  const joined = text.replace(/\\\n\s*/g, ' ');
  // Then by command rather than by line, because one body is a JSON object
  // printed over three lines with no continuations at all: splitting on
  // newlines cut it in half and the test reported that the service refuses its
  // own documented example.
  const chunks = joined.split(/\n(?=curl )/).flatMap((part) => {
    const at = part.indexOf('curl ');
    return at === -1 ? [] : [part.slice(at)];
  });
  for (const chunk of chunks) {
    const command = chunk.split(/\n```/)[0]!.trim();
    if (!command.startsWith('curl ')) continue;
    // `-sX POST` is how the documents write it, so the flag is not `-X` on its
    // own: the first version of this read every command as a GET and reported
    // that the signup route does not exist.
    const method = /-[a-zA-Z]*X\s+([A-Z]+)/.exec(command)?.[1] ?? 'GET';
    // The URL is the first argument that looks like one, quoted or not.
    const url = /(?:"([^"]*\$MUSTER[^"]*)"|'([^']*\$MUSTER[^']*)'|(\$MUSTER\S*)|(https?:\/\/\S+))/.exec(
      command,
    );
    const target = url?.[1] ?? url?.[2] ?? url?.[3] ?? url?.[4];
    if (!target) continue;
    const body = /-d\s+'([\s\S]*?)'(?:\s|$)/.exec(command)?.[1];
    found.push({ method, url: target, ...(body ? { body } : {}) });
  }
  return found;
}

/** The code a rendered page prints, as the plain text a reader would copy. */
export function codeOn(html: string): string {
  const blocks = html.match(/<pre[^>]*>[\s\S]*?<\/pre>/g) ?? [];
  return blocks
    .map((block) =>
      block
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    )
    .join('\n\n');
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
  fill: (text: string) => string,
  token: string,
): Promise<Injected> {
  const url = fill(command.url);
  const headers = url.startsWith('/v1/')
    ? { authorization: `Bearer ${token}` }
    : { 'content-type': 'application/json' };
  const answer = await harness.server.inject({
    method: command.method as 'POST',
    url,
    headers,
    ...(command.body ? { payload: JSON.parse(fill(command.body)) } : {}),
  });
  const refusal = answer.statusCode === 404 ? String(answer.json().error ?? '') : '';
  if (refusal !== 'not_accepting') {
    assert.ok(
      ![400, 404, 405].includes(answer.statusCode),
      `${command.method} ${url} answered ${answer.statusCode}: ${answer.body.slice(0, 200)}`,
    );
  }
  return answer;
}

/** Everything a reference page's placeholders stand for, freshly made. */
interface Fixtures {
  project: string;
  token: string;
  slug: string;
  escalation: string;
  key: string;
}

async function seed(): Promise<Fixtures> {
  const project = await createProject(harness, 'docs-page');
  const headers = authed(project);
  await harness.server.inject({
    method: 'POST',
    url: `${project.api}/items`,
    headers,
    payload: { slug: 'ops:cutover', title: 'Cut traffic over to the new venue' },
  });
  const escalation = await harness.server.inject({
    method: 'POST',
    url: `${project.api}/escalations`,
    headers,
    payload: { question: 'Bridge it or wait for the venue?' },
  });
  const key = await harness.server.inject({
    method: 'POST',
    url: `${project.api}/keys`,
    headers,
    payload: { name: 'spare', role: 'write' },
  });
  return {
    project: project.id,
    token: project.token,
    slug: 'ops:cutover',
    escalation: escalation.json().escalation.id,
    key: key.json().key.id,
  };
}

describe('every curl this service prints', () => {
  it('walks the protocol document from its own signup', async () => {
    const doc = (await harness.server.inject({ method: 'GET', url: '/skill.md' })).body;
    const commands = commandsIn(doc);
    assert.ok(commands.length >= 25, `the document has commands in it: found ${commands.length}`);

    // Taken from the page, not from the harness: the document opens by
    // signing up and then tells the reader to point everything that follows at
    // what it handed back. A fixture project here would still pass if that
    // handoff broke, which is the one thing this document is for.
    let project = '';
    let token = '';
    const fill = (text: string): string =>
      text
        .replace('$MUSTER', `/v1/${project}`)
        .replace(harness.config.baseUrl, '')
        .replace('$HANDLE', 'errors-loop')
        .replace('$LAST_AS_OF', new Date().toISOString());

    let ran = 0;
    for (const command of commands) {
      // Placeholders the document tells the reader to fill in themselves. A
      // test that invented an escalation id would be testing its own guess.
      if (/[<>]/.test(command.url) || (command.body && /[<>]/.test(command.body))) continue;
      const answer = await runAsPrinted(command, fill, token);
      if (command.url.endsWith('/p') && answer.statusCode === 201) {
        project = answer.json().project;
        token = answer.json().token;
      }
      ran += 1;
    }
    assert.ok(project, 'the signup the document prints handed back a project');
    assert.ok(ran >= 24, `most of the document is runnable as printed: ran ${ran}`);
  });

  it('walks the signup document too, including the claim it ends on', async () => {
    // Same promise, a different page, and the one a stranger reads first. Its
    // placeholders are angle brackets rather than shell variables, and the
    // printed code is a placeholder as well: six digits nobody can guess,
    // because only the server mints them.
    const doc = (await harness.server.inject({ method: 'GET', url: '/agent-signup.md' })).body;
    const commands = commandsIn(doc);
    assert.ok(commands.length >= 4, `the signup document has commands in it: ${commands.length}`);

    let project = '';
    let token = '';
    const fill = (text: string): string =>
      text
        .replace(harness.config.baseUrl, '')
        .replace('<project>', project)
        .replace('<admin token>', token)
        .replace('<token>', token)
        .replace(/"code":\s*"\d{6}"/, `"code":"${posted.at(-1) ?? '000000'}"`);

    for (const command of commands) {
      const answer = await runAsPrinted(command, fill, token);
      if (command.url.endsWith('/p') && answer.statusCode === 201) {
        project = answer.json().project;
        token = answer.json().token;
      }
    }

    // Not "nothing answered 404": the page ends on a claim and its
    // verification, so the project it told a stranger to create is owned
    // afterwards, or the page walked them through steps that do not add up.
    assert.ok(posted.length > 0, 'the claim in the document actually asked for a code');
    const owned = await harness.store.projects.findOne({ _id: project });
    assert.equal(owned?.claimedBy, 'human@example.com', 'and the verification took');
  });

  it('answers every command the docs pages print', async () => {
    let ran = 0;
    for (const page of ['/', '/docs', '/docs/keys']) {
      const rendered = await harness.server.inject({
        method: 'GET',
        url: page,
        headers: { accept: 'text/html' },
      });
      const commands = commandsIn(codeOn(rendered.body));
      assert.ok(commands.length > 0, `${page} prints commands a reader can copy`);
      for (const command of commands) {
        // A fresh project each time, because these pages are a reference and
        // their examples are not a sequence: the layout one replaces the
        // default columns, and the move below it names a column of the board
        // it replaced.
        const fixtures = await seed();
        const fill = (text: string): string =>
          text
            .replace(harness.config.baseUrl, '')
            .replace(/\$PROJECT/g, fixtures.project)
            .replace(/\$ADMIN_TOKEN/g, fixtures.token)
            .replace(/\$TOKEN/g, fixtures.token)
            .replace(/\$SLUG/g, fixtures.slug)
            .replace(/\$KEY_ID/g, fixtures.key)
            .replace(/\$ID/g, fixtures.escalation);
        await runAsPrinted(command, fill, fixtures.token);
        ran += 1;
      }
    }
    assert.ok(ran >= 9, `every example on those pages ran: ${ran}`);
  });
});
