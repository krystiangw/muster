import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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

  before(async () => {
    harness = await startHarness();
    mine = await createProject(harness, 'my board');
    theirs = await createProject(harness, 'somebody else');

    // Their board, with something on it to find: a route that leaks would
    // otherwise answer "nothing here" and look like a refusal.
    const write = (path: string, payload: Record<string, unknown>) =>
      harness.server.inject({
        method: 'POST',
        url: `${theirs.api}${path}`,
        headers: authed(theirs),
        payload,
      });
    await write('/agents', { handle: 'their-agent', description: 'not yours' });
    await write('/items', { slug: 'their-card', title: 'their work', actor: 'their-agent' });
    await write('/items/their-card/claim', { agent: 'their-agent' });
    await write('/escalations', { agent: 'their-agent', question: 'their question' });
  });

  after(async () => {
    await harness.stop();
  });

  /**
   * A body this route would accept, built from the schema it publishes.
   *
   * The first version of this sweep sent one body with every field in it, and
   * every schema here refuses a field it does not have, so most doors were
   * turning it away for the shape of the body rather than for the token. A
   * test that cannot tell those apart is a test that would have watched this
   * leak. Only the required fields, filled by type, so the request is valid
   * and the only thing left to refuse is who is asking.
   */
  const bodyFor = (schema: Record<string, any> | undefined): Record<string, unknown> | undefined => {
    if (!schema || schema.type !== 'object') return undefined;
    const props = (schema.properties ?? {}) as Record<string, any>;
    const body: Record<string, unknown> = {};
    for (const name of (schema.required ?? []) as string[]) {
      const field = props[name] ?? {};
      if (Array.isArray(field.enum) && field.enum.length > 0) {
        body[name] = field.enum[0];
      } else if (field.type === 'array') {
        body[name] = [];
      } else if (field.type === 'integer' || field.type === 'number') {
        body[name] = field.minimum ?? 1;
      } else if (field.type === 'boolean') {
        body[name] = true;
      } else if (field.type === 'object') {
        body[name] = {};
      } else if (name === 'email') {
        body[name] = 'nobody@example.com';
      } else {
        body[name] = name === 'slug' ? 'their-card' : `taken-by-${name}`;
      }
    }
    return body;
  };

  /** Every project-scoped route the service publishes, with its parameters filled. */
  type Door = { method: string; url: string; body: Record<string, unknown> | undefined };
  const doors = async (): Promise<Door[]> => {
    const openapi = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json();
    const asked = await harness.server.inject({
      method: 'GET',
      url: `${theirs.api}/escalations`,
      headers: authed(theirs),
    });
    const escalationId = asked.json().escalations?.[0]?.id ?? 'e_nothing';

    const out: Door[] = [];
    for (const [route, methods] of Object.entries(
      openapi.paths as Record<string, Record<string, any>>,
    )) {
      if (!route.startsWith('/v1/{project}')) continue;
      const url = route
        .replace('{project}', theirs.id)
        .replace('{slug}', 'their-card')
        .replace('{handle}', 'their-agent')
        .replace('{id}', escalationId)
        .replace('{key}', 'k_nothing');
      // Anything still in braces is a parameter this sweep does not know how
      // to fill, and guessing would test the guess. Better to fail loudly than
      // to skip quietly.
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
    const list = await doors();
    // A sweep that found nothing would pass in silence, which is the one
    // outcome this must not have.
    assert.ok(list.length >= 15, `the document listed the project routes: ${list.length}`);

    const leaked: string[] = [];
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
    assert.equal(await harness.store.items.countDocuments({ projectId: theirs.id }), 1);
    assert.equal(await harness.store.agents.countDocuments({ projectId: theirs.id }), 1);
    assert.equal(await harness.store.escalations.countDocuments({ projectId: theirs.id }), 1);
    assert.equal(await harness.store.keys.countDocuments({ projectId: theirs.id }), 1);
  });
});
