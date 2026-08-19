import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashToken } from '../src/ids.js';
import { authed, createProject, startHarness, type Harness, type Project } from './helper.js';

/**
 * One token, one board, on every door there is.
 *
 * Every project route carries the project in its path and a token in its
 * header, and one check says those must agree. It was held by a single example
 * on a single route, chosen by hand, out of thirty five method and route
 * combinations. The one that forgets a check is by definition the one nobody
 * thought about, so the inventory comes from the OpenAPI document, which is
 * generated from what is actually registered, and every project route in it is
 * asked with the wrong token in hand.
 *
 * What that check is, exactly, is worth writing down, because taking it out
 * shows something reassuring. The handlers behind these doors resolve the
 * board from the token rather than from the path, so a caller who names
 * somebody else's project and loses this check does not read their board: it
 * reads its own, under their address. The breach would be a coding error in a
 * handler, not the absence of this line. What this line prevents is quieter
 * and still worth preventing: an agent working confidently against the wrong
 * board because a copied URL and a held token disagreed and nothing said so.
 *
 * The rule asserted is therefore narrow: the answer must not be a success, and
 * must not describe the board it could not reach. A 404 is as good an answer
 * as a 403 here, and for a board narrowed to its owner it is the better one.
 */
describe('a token from one project, at every door of another', () => {
  let harness: Harness;
  let mine: Project;
  let theirs: Project;

  /** Ids in my own project, so no door can turn me away for a thing that is missing. */
  let myEscalation = '';
  let myKey = '';
  /** And theirs, to try on my own doors. */
  let theirEscalation = '';
  let theirKey = '';
  /** What their board held before anybody knocked on it. */
  let atRest: Record<string, number> = {};

  before(async () => {
    // The limits raised for this file alone. The sweep restores its fixtures
    // before each of thirty five doors, which is several hundred writes in a
    // few seconds, and production limits would start refusing them: the sweep
    // would then be reading its own throttling as isolation, which is the
    // exact mistake this file has already made in four other ways.
    harness = await startHarness({
      LIMIT_WRITES_PER_MINUTE: '5000',
      LIMIT_READS_PER_MINUTE: '5000',
      LIMIT_CLAIM_EMAILS_PER_HOUR: '5000',
      LIMIT_CODE_ATTEMPTS_PER_HOUR: '5000',
    });
    mine = await createProject(harness, 'my board');
    theirs = await createProject(harness, 'somebody else');

    const fill = async (project: Project, prefix: string) => {
      const write = (path: string, payload: Record<string, unknown>) =>
        harness.server.inject({
          method: 'POST',
          url: `${project.api}${path}`,
          headers: authed(project),
          payload,
        });
      await write('/agents', { handle: `${prefix}-agent`, description: 'someone' });
      await write('/items', { slug: `${prefix}-card`, title: `${prefix} work`, actor: `${prefix}-agent` });
      await write(`/items/${prefix}-card/claim`, { agent: `${prefix}-agent` });
      const asked = await write('/escalations', { agent: `${prefix}-agent`, question: `${prefix} question` });
      const key = await write('/keys', { role: 'write', name: `${prefix} key` });
      return { escalation: asked.json().escalation?.id ?? '', key: key.json().key?.id ?? '' };
    };

    // Both boards, furnished the same way. Their board so that a door which
    // leaks has something to name, and mine because of what the guard does
    // when it is missing: authentication resolves my project, so a route
    // looking for a card or a question finds nothing and answers 404, and a
    // sweep that accepts 404 would have counted that as protection. Every
    // placeholder below is a thing that exists in my project, so absent the
    // guard each of these doors would answer.
    const theirIds = await fill(theirs, 'their');
    theirEscalation = theirIds.escalation;
    theirKey = theirIds.key;
    const ids = await fill(mine, 'my');
    myEscalation = ids.escalation;
    myKey = ids.key;
    // Answered, because acknowledging one that has no answer is refused on its
    // own merits and that refusal would hide whether the door was reached.
    await harness.server.inject({
      method: 'PATCH',
      url: `${mine.api}/escalations/${myEscalation}`,
      headers: { ...authed(mine), 'content-type': 'application/json' },
      payload: { status: 'answered', answer: 'so that ack has something to do' },
    });
    assert.ok(myEscalation && myKey, 'the fixtures for my own board were made');

    // Counted rather than assumed: a bootstrap token is a key too, and a
    // hardcoded one here would only ever be a note about how the fixture
    // looked on the day it was written.
    atRest = await counts();
  });

  after(async () => {
    await harness.stop();
  });

  /**
   * A body this route would accept, built from the schema it publishes.
   *
   * The first version sent one body carrying every field, and every schema
   * here refuses a field it does not have, so most doors were turning it away
   * for the shape of the body rather than for the token. The second version
   * sent only required fields but ignored what those fields require of
   * themselves: an empty array where one item is the minimum, a thirteen
   * character string where the code is six. Fastify refuses both before the
   * check being tested ever runs, which reads as protection and is not.
   */
  const valueFor = (name: string, field: Record<string, any>): unknown => {
    if (Array.isArray(field.enum) && field.enum.length > 0) return field.enum[0];
    if (field.type === 'array') {
      // The one place the document cannot describe what the handler wants: a
      // board column is published as an open object with no properties at all,
      // so a generator reading the schema builds `{}` and is refused for a
      // missing title. Named here rather than guessed, and named once.
      const one =
        name === 'columns'
          ? { key: 'todo', title: 'To do', match: { status: ['open'] } }
          : (bodyFor(field.items) ?? valueFor(name, field.items ?? { type: 'string' }));
      return Array.from({ length: Math.max(field.minItems ?? 1, 1) }, () => one);
    }
    if (field.type === 'object') return bodyFor(field, true) ?? {};
    if (field.type === 'integer' || field.type === 'number') return field.minimum ?? 1;
    if (field.type === 'boolean') return true;
    if (name === 'email') return 'nobody@example.com';
    // Long enough to be accepted, short enough to be allowed. A field that
    // pins both to the same number, as the six digit code does, gets exactly
    // that many characters.
    const wanted =
      name === 'slug'
        ? 'my-card'
        : name === 'handle'
          ? 'my-agent'
          : // A column key this board has. Free text in the schema, closed in
            // the handler, and a name it does not know is refused before the
            // check being tested.
            name === 'column'
            ? 'done'
            : // The six digits somebody was emailed. Wrong ones are refused
              // for being wrong, which is that door working and this sweep
              // never arriving at it.
              name === 'code'
              ? '123456'
              : `taken-${name}`;
    const min = field.minLength ?? 0;
    const max = field.maxLength ?? Math.max(wanted.length, min);
    const padded = wanted.length < min ? wanted.padEnd(min, '1') : wanted;
    return padded.slice(0, Math.max(max, min));
  };

  function bodyFor(
    schema: Record<string, any> | undefined,
    everything = false,
  ): Record<string, unknown> | undefined {
    if (!schema || schema.type !== 'object') return undefined;
    const props = (schema.properties ?? {}) as Record<string, any>;
    // Required fields at the top, every declared field inside a nested object.
    // A board column declares only `key` as required and is refused without a
    // title, which is the schema being looser than the handler: filling what
    // the object declares gets past the door rather than around it.
    const wanted = everything ? Object.keys(props) : ((schema.required ?? []) as string[]);
    const body: Record<string, unknown> = {};
    for (const name of wanted) {
      body[name] = valueFor(name, props[name] ?? { type: 'string' });
    }
    return body;
  }

  /** Every project-scoped route the service publishes, with its parameters filled. */
  type Door = { method: string; url: string; body: Record<string, unknown> | undefined };
  const doors = async (at: string, whose: 'my' | 'their'): Promise<Door[]> => {
    const openapi = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json();

    const out: Door[] = [];
    for (const [route, methods] of Object.entries(
      openapi.paths as Record<string, Record<string, any>>,
    )) {
      if (!route.startsWith('/v1/{project}')) continue;
      // Resolved per route, because two different resources are both called
      // `{id}` here: sending an escalation id to the key door made that door
      // answer 404 for a thing that was never there, which is not the refusal
      // this is looking for.
      const url = route
        .replace('{project}', at)
        .replace('{slug}', `${whose}-card`)
        .replace('{handle}', `${whose}-agent`)
        .replace(
          '{id}',
          route.includes('/keys/')
            ? whose === 'my'
              ? myKey
              : theirKey
            : whose === 'my'
              ? myEscalation
              : theirEscalation,
        )
        .replace('{key}', whose === 'my' ? myKey : theirKey);
      assert.doesNotMatch(url, /[{}]/, `fill this parameter before trusting the sweep: ${route}`);
      for (const [method, operation] of Object.entries(methods)) {
        out.push({
          method: method.toUpperCase(),
          url,
          body: bodyFor(operation?.requestBody?.content?.['application/json']?.schema),
        });
      }
    }
    return out;
  };

  it('is turned away at every one of them', async () => {
    const list = await doors(theirs.id, 'my');
    // A sweep that found nothing would pass in silence, which is the one
    // outcome this must not have.
    assert.ok(list.length >= 15, `the document listed the project routes: ${list.length}`);

    const leaked: string[] = [];
    for (const door of list) {
      // Before each one, because the sweep contains a delete: with the guard
      // absent that delete lands on my own card, and every later item route
      // then answers "no such item", which reads as protection and is the
      // sweep tripping over its own feet. Upserted on my board with my token,
      // which is not the request being measured.
      await harness.server.inject({
        method: 'POST',
        url: `${mine.api}/items`,
        headers: { ...authed(mine), 'content-type': 'application/json' },
        payload: { slug: 'my-card', title: 'my work', actor: 'my-agent' },
      });
      // And the answer, for the same reason: the sweep also carries a PATCH
      // that puts a question back to open, and the door after it acknowledges
      // one, which is refused when there is nothing to acknowledge.
      await harness.server.inject({
        method: 'PATCH',
        url: `${mine.api}/escalations/${myEscalation}`,
        headers: { ...authed(mine), 'content-type': 'application/json' },
        payload: { status: 'answered', answer: 'so that ack has something to do' },
      });
      // And a claim waiting on my own board with a code this sweep knows. The
      // last door verifies six digits that were emailed to somebody, so
      // without this it refuses a wrong code, which is that door working
      // rather than this test reaching it. Minted through the door that mints
      // them, then the hash replaced, which is what the operator sign-in
      // helper does for the same reason.
      await harness.server.inject({
        method: 'POST',
        url: `${mine.api}/claim`,
        headers: { ...authed(mine), 'content-type': 'application/json' },
        payload: { email: 'nobody@example.com' },
      });
      await harness.store.claimCodes.updateMany(
        { projectId: mine.id },
        { $set: { codeHash: hashToken('123456') } },
      );
      const answer = await harness.server.inject(
        door.body === undefined
          ? { method: door.method as 'GET', url: door.url, headers: authed(mine) }
          : {
              method: door.method as 'POST',
              url: door.url,
              headers: { ...authed(mine), 'content-type': 'application/json' },
              payload: door.body,
            },
      );
      if (answer.statusCode < 400) {
        leaked.push(`${door.method} ${door.url} answered ${answer.statusCode}`);
        continue;
      }
      // Not merely refused: refused without describing what is behind the
      // door. Their card's title is the thing a leak would spell out.
      if (answer.body.includes('their work') || answer.body.includes('their question')) {
        leaked.push(`${door.method} ${door.url} said what is on the board`);
      }
    }
    assert.deepEqual(leaked, [], `a token reached somebody else's board:\n${leaked.join('\n')}`);
  });

  it('refuses their card, their question and their key at my own doors', async () => {
    // The other direction, and the one an attacker takes. The first sweep asks
    // somebody else's address with my token, which the check in front of every
    // route settles. This one is a request that check is happy with: my token,
    // my project in the path, and a reference to something on their board in
    // the parameter. Nothing in front of the handler can catch that. It is
    // caught, if it is caught, by every lookup carrying the project beside the
    // id, and a lookup that forgets is invisible until somebody notices their
    // question was answered by a stranger.
    const list = (await doors(mine.id, 'their')).filter((door) => /(their-card|their-agent)/.test(door.url) || door.url.includes(theirEscalation) || door.url.includes(theirKey));
    assert.ok(list.length >= 8, `the routes that take a reference: ${list.length}`);

    const reached: string[] = [];
    for (const door of list) {
      const answer = await harness.server.inject(
        door.body === undefined
          ? { method: door.method as 'GET', url: door.url, headers: authed(mine) }
          : {
              method: door.method as 'POST',
              url: door.url,
              headers: { ...authed(mine), 'content-type': 'application/json' },
              payload: door.body,
            },
      );
      if (answer.statusCode < 400) reached.push(`${door.method} ${door.url} answered ${answer.statusCode}`);
      if (answer.body.includes('their work') || answer.body.includes('their question')) {
        reached.push(`${door.method} ${door.url} read it out`);
      }
    }
    assert.deepEqual(reached, [], `a reference reached across boards:\n${reached.join('\n')}`);
  });

  it('leaves their key working after somebody tried to revoke it from another board', async () => {
    // The effect, not the status code. A revoke that answers 404 and deletes
    // the row anyway has done the damage and reported innocence.
    const stored = await harness.store.keys.findOne({ projectId: theirs.id, _id: theirKey });
    assert.equal(stored?.revokedAt ?? null, null, 'their key was not revoked');

    const question = await harness.store.escalations.findOne({ projectId: theirs.id, _id: theirEscalation });
    assert.equal(question?.status, 'open', 'and their question was not answered for them');
    assert.equal(question?.acknowledgedAt ?? null, null, 'nor acknowledged');
  });

  it('refuses their question through a read link that is not theirs', async () => {
    // The same reference, at the door a stranger reaches without a token at
    // all. A read link is a URL somebody pastes into a chat, and the form
    // behind it answers questions, so the id in that form is the one piece of
    // it a reader can change. It resolves the board from the link and hands
    // that board to the lookup, which is what makes the id harmless.
    const myLink = mine.readUrl.split('/r/')[1]!;
    const answered = await harness.server.inject({
      method: 'POST',
      url: `/r/${myLink}/escalations/${theirEscalation}`,
      payload: 'status=answered&answer=answered+from+the+wrong+board',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // What a browser on our own page sends, so this is refused for the
        // reference rather than for looking like a stranger's form.
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
    });
    assert.notEqual(answered.statusCode, 303, 'it did not go through');

    const question = await harness.store.escalations.findOne({
      projectId: theirs.id,
      _id: theirEscalation,
    });
    assert.equal(question?.status, 'open', 'and their question is untouched');
    assert.equal(question?.answer ?? '', '', 'with nothing written into it');
  });

  /** Everything of theirs that a door could have made or unmade. */
  const counts = async (): Promise<Record<string, number>> => ({
    items: await harness.store.items.countDocuments({ projectId: theirs.id }),
    agents: await harness.store.agents.countDocuments({ projectId: theirs.id }),
    escalations: await harness.store.escalations.countDocuments({ projectId: theirs.id }),
    keys: await harness.store.keys.countDocuments({ projectId: theirs.id }),
  });

  it('changes nothing on the board it could not reach', async () => {
    // The half a status code cannot show: a route that refuses after writing
    // answered correctly and did the damage anyway. Counts rather than
    // contents, because the sweep sends only the fields a schema requires and
    // most of those writes would be no-ops even if they landed. What this
    // catches is a door that creates something, which is the shape that
    // matters here.
    const card = await harness.store.items.findOne({ projectId: theirs.id, slug: 'their-card' });
    assert.equal(card?.title, 'their work', 'the title is theirs');
    assert.equal(card?.claim?.agent, 'their-agent', 'and so is the lease');
    assert.equal(card?.status, 'open', 'and it was not moved');
    assert.deepEqual(await counts(), atRest, 'nothing was made or unmade on their board');
  });
});
