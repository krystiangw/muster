import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
// Imported from source rather than from the built package so a broken SDK
// fails this suite instead of silently testing a stale dist.
import { Muster } from '../../../packages/sdk/src/index.js';
import { startHarness, type Harness } from './helper.js';

let harness: Harness;
let baseUrl: string;

before(async () => {
  harness = await startHarness();
  const address = await harness.server.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = address;
});

after(async () => {
  await harness.stop();
});

describe('the typed SDK', () => {
  it('drives a whole session: signup, register, upsert, claim, escalate, inbox', async () => {
    const { client, created } = await Muster.start({
      name: 'sdk-session',
      actor: 'errors-loop',
      baseUrl,
    });
    assert.match(created.token, /^mk_/);

    await client.registerAgent({ handle: 'errors-loop', scope: ['errors:'] });

    const upserted = await client.upsert({
      slug: 'errors:one',
      title: 'first problem',
      body: 'details',
    });
    assert.equal(upserted.created, true);
    assert.equal(upserted.item.status, 'open');

    const next = await client.next();
    assert.equal(next.item?.slug, 'errors:one');

    const claimed = await client.claim('errors:one');
    assert.equal(claimed.ok, true);

    // The filter the HTTP query had and this client did not, which meant an
    // SDK caller asking "what is somebody on" had to read everything and sort
    // it out itself.
    const held = await client.items({ claimed: true });
    assert.deepEqual(
      held.items.map((item) => item.slug),
      ['errors:one'],
    );
    assert.equal((await client.items({ claimed: false })).items.length, 0);

    const contested = new Muster({
      project: created.project,
      token: created.token,
      baseUrl,
      actor: 'other-loop',
    });
    const refused = await contested.claim('errors:one');
    assert.equal(refused.ok, false);
    assert.equal(refused.held_by, 'errors-loop');

    await client.note('errors:one', 'pool depth too thin');
    const escalated = await client.escalate({
      question: 'bridge or wait?',
      itemSlug: 'errors:one',
      priority: 'high',
    });
    assert.equal(escalated.escalation.status, 'open');

    const inbox = await client.inbox();
    assert.equal(inbox.answers.length, 0);

    await client.release('errors:one');
    const taken = await contested.claim('errors:one');
    assert.equal(taken.ok, true);
  });

  it('withClaim runs the work, keeps the lease and releases it even after a throw', async () => {
    const { client } = await Muster.start({ name: 'with-claim', actor: 'worker', baseUrl });
    await client.upsert({ slug: 'job', title: 'a job' });

    const done = await client.withClaim('job', async (item) => {
      assert.equal(item.slug, 'job');
      const held = await client.item('job');
      assert.equal(held.item.claim?.agent, 'worker');
      return 'finished';
    });
    assert.equal(done, 'finished');
    assert.equal((await client.item('job')).item.claim, null);

    await assert.rejects(
      client.withClaim('job', async () => {
        throw new Error('work blew up');
      }),
      /work blew up/,
    );
    assert.equal((await client.item('job')).item.claim, null, 'a throw must not leak the lease');
  });

  it('returns null from withClaim instead of duplicating somebody else’s work', async () => {
    const { client, created } = await Muster.start({ name: 'contended', actor: 'first', baseUrl });
    await client.upsert({ slug: 'job', title: 'a job' });
    await client.claim('job', 'first', 60);

    const second = new Muster({
      project: created.project,
      token: created.token,
      baseUrl,
      actor: 'second',
    });
    let ran = false;
    const result = await second.withClaim('job', async () => {
      ran = true;
      return 'should not happen';
    });
    assert.equal(result, null);
    assert.equal(ran, false);
  });

  it('throws on a 409 that is a real failure, and only passes the contested claim through', async () => {
    const { client, created } = await Muster.start({ name: 'conflicts', actor: 'a', baseUrl });
    await client.upsert({ slug: 'held', title: 'held' });
    await client.claim('held', 'a', 60);

    // A heartbeat from the wrong agent is a failure, not a result. Swallowing it
    // would let the caller carry on believing it holds the lease.
    await assert.rejects(client.heartbeat('held', 'someone-else'), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.equal((error as { code?: string }).code, 'not_claim_holder');
      return true;
    });

    // A full project is a failure too.
    const direct = await fetch(`${baseUrl}/v1/${created.project}/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', title: 'x', actor: 'a' }),
    });
    assert.ok(direct.ok);
    await harness.store.projects.updateOne(
      { _id: created.project },
      { $set: { 'limits.items': 1 } },
    );
    await assert.rejects(client.upsert({ slug: 'over-the-cap', title: 'nope' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'limit_reached');
      return true;
    });

    // The contested claim still comes back as an answer.
    const contested = await new Muster({
      project: created.project,
      token: created.token,
      baseUrl,
      actor: 'b',
    }).claim('held');
    assert.equal(contested.ok, false);
    assert.equal(contested.held_by, 'a');
  });

  it('migrates history, answers a question and pages through the queue', async () => {
    const { client } = await Muster.start({ name: 'migration', actor: 'importer', baseUrl });

    await client.upsert({
      slug: 'from-elsewhere',
      title: 'came from another system',
      history: [
        { at: '2026-05-02T09:00:00.000Z', by: 'old-loop', message: 'second' },
        { at: '2026-04-16T20:16:55.485Z', by: 'old-loop', message: 'first' },
      ],
    });
    const migrated = await client.item('from-elsewhere');
    assert.equal(migrated.item.timeline?.[0]?.message, 'first');
    assert.equal(migrated.item.timeline?.[0]?.by, 'old-loop');

    for (let i = 0; i < 3; i += 1) {
      await client.escalate({ question: `question ${i}` });
    }
    const everything = await client.allEscalations();
    assert.equal(everything.length, 3);

    const answered = await client.answer(everything[0]!.id, 'wont_do', 'not this week');
    assert.equal(answered.escalation.status, 'wont_do');
    const inbox = await client.inbox();
    assert.equal(inbox.answers.length, 1);

    await client.deleteItem('from-elsewhere');
    await assert.rejects(client.item('from-elsewhere'));
  });

  it('reads and lays out the board, and hands the project to a person', async () => {
    const { client, created } = await Muster.start({
      name: 'sdk-board',
      description: 'what this board is for',
      actor: 'errors-loop',
      baseUrl,
    });
    assert.equal(created.description, 'what this board is for');

    await client.upsert({ slug: 'watch', title: 'watching', labels: ['monitoring'] });
    await client.upsert({ slug: 'busy', title: 'busy' });
    await client.claim('busy', 'errors-loop', 30);

    const before = await client.board();
    assert.equal(before.rows[0]?.columns.find((cell) => cell.key === 'doing')?.count, 1);

    await client.setBoard({
      rows: 'none',
      columns: [
        { title: 'Monitoring', match: { labels: ['monitoring'], status: ['open'] } },
        { title: 'Rest', match: {} },
      ],
    });
    const after = await client.board();
    assert.deepEqual(
      after.board.columns.map((column) => column.title),
      ['Monitoring', 'Rest'],
    );
    assert.equal(after.rows[0]?.columns[0]?.items?.[0]?.slug, 'watch');

    const presets = await client.boardPresets();
    assert.ok(presets.presets.length >= 3);

    const moved = await client.move('busy', 'monitoring', { note: 'watching it instead' });
    assert.equal(moved.landed_in, 'monitoring');
    assert.ok(moved.item.labels.includes('monitoring'));

    const shared = await client.share({ email: 'nobody@example.com', note: 'yours now' });
    assert.equal(shared.ok, true);
    assert.match(shared.tell_them!, /\/r\/r_/);

    const described = await client.describe({ description: 'renamed from the SDK' });
    assert.equal(described.description, 'renamed from the SDK');
  });

  it('raises a typed error with the server’s own message', async () => {
    const { client } = await Muster.start({ name: 'errors', actor: 'a', baseUrl });
    await assert.rejects(client.item('nothing-here'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 404);
      assert.equal((error as { code?: string }).code, 'not_found');
      return true;
    });
  });

  it('carries the wait, and says whether coming back is the move', async () => {
    // The service publishes this twice on every answer that means later: the
    // `retry-after` header and `retry_after` in the body. It survived neither
    // trip through the SDK, which read no headers and handed the body back as
    // `unknown`, so a caller had to know the field name and cast to reach it.
    // A loop that cannot see the number either hammers a door that already
    // said when to knock, or invents a delay of its own.
    const { client } = await Muster.start({ name: 'waiting', actor: 'a', baseUrl });

    // A rate limit, taken from the door that publishes the smallest budget
    // rather than by hammering a real one.
    const limited = new Response(
      JSON.stringify({ error: 'rate_limited', limit: 'writes', message: 'Too many.', retry_after: 7 }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } },
    );
    const patient = new Muster({
      project: client.project,
      token: 'irrelevant',
      baseUrl,
      fetch: async () => limited.clone(),
    });
    await assert.rejects(patient.items(), (error: unknown) => {
      const said = error as { retryAfterSeconds?: number | null; retryable?: boolean; code?: string };
      assert.equal(said.code, 'rate_limited');
      assert.equal(said.retryAfterSeconds, 7, 'the number arrives');
      assert.equal(said.retryable, true, 'and it says coming back is the move');
      return true;
    });

    // The header wins over the body, because it is where HTTP puts this and it
    // survives an answer that is not JSON at all.
    const headerOnly = new Response('upstream is having a minute', {
      status: 503,
      headers: { 'content-type': 'text/plain', 'retry-after': '5' },
    });
    const patientAgain = new Muster({
      project: client.project,
      token: 'irrelevant',
      baseUrl,
      fetch: async () => headerOnly.clone(),
    });
    await assert.rejects(patientAgain.items(), (error: unknown) => {
      const said = error as { retryAfterSeconds?: number | null; retryable?: boolean };
      assert.equal(said.retryAfterSeconds, 5);
      assert.equal(said.retryable, true);
      return true;
    });

    // And an answer that means the request was wrong says nothing about
    // waiting, because waiting will not help.
    await assert.rejects(client.item('nothing-here'), (error: unknown) => {
      const said = error as { retryAfterSeconds?: number | null; retryable?: boolean };
      assert.equal(said.retryAfterSeconds, null);
      assert.equal(said.retryable, false);
      return true;
    });

    // Signup is the first call an agent makes and the one there is no client
    // yet to retry with, and it read its answer a different way: `.json()`
    // threw before any of this, on exactly the answer this is for.
    await assert.rejects(
      Muster.createProject({
        name: 'behind a bad proxy',
        baseUrl,
        fetch: async () =>
          new Response('<html>502 Bad Gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html', 'retry-after': '11' },
          }),
      }),
      (error: unknown) => {
        const said = error as { status?: number; retryAfterSeconds?: number | null; name?: string };
        assert.equal(said.name, 'MusterError', 'and not a complaint about JSON');
        assert.equal(said.status, 502);
        assert.equal(said.retryAfterSeconds, 11);
        return true;
      },
    );

    // Tolerance belongs on the way out and not on the way in. An answer that
    // says it worked and cannot be read is not the answer the call promised,
    // and handing it back would give the caller an object with every field
    // undefined to carry on with.
    const lying = new Muster({
      project: client.project,
      token: 'irrelevant',
      baseUrl,
      fetch: async () =>
        new Response('<html>hello from a proxy</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    await assert.rejects(lying.items(), (error: unknown) => {
      const said = error as { code?: string; status?: number; name?: string };
      assert.equal(said.name, 'MusterError');
      assert.equal(said.code, 'unreadable_answer');
      assert.equal(said.status, 200);
      return true;
    });

    // Nothing at all counts as unreadable too. Every 2xx this service sends
    // carries a body, down to `{"ok":true}` from a delete, so an empty one is
    // never this service answering; treating it as an empty object let start()
    // hand back a client with no project and no token and carry on.
    await assert.rejects(
      Muster.start({
        name: 'answered with nothing',
        baseUrl,
        fetch: async () => new Response('', { status: 200 }),
      }),
      (error: unknown) => {
        const said = error as { code?: string; name?: string; message?: string };
        assert.equal(said.name, 'MusterError');
        assert.equal(said.code, 'unreadable_answer');
        assert.match(String(said.message), /empty/);
        return true;
      },
    );
  });

  it('reaches every call a project token can make', async () => {
    /**
     * The gap this found was the one that mattered: `next()` was the GET, which
     * looks and does not take, and nothing here could reach the POST. A fleet
     * built on this package therefore did exactly what that endpoint was
     * written to stop, with everybody offered the same card and one of them
     * winning. The service had solved it and the layer agents import could not
     * say so.
     *
     * Read out of the published document rather than from a list kept here, so
     * a call added to the service is either wrapped or named below as
     * deliberately absent.
     */
    const spec = (await harness.server.inject({ method: 'GET', url: '/openapi.json' })).json() as {
      paths: Record<string, Record<string, unknown>>;
    };

    // Not through a project client, and each for its own reason.
    const elsewhere = new Map([
      ['GET /.well-known/oauth-authorization-server', 'metadata a client reads before it has a token'],
      ['GET /.well-known/oauth-protected-resource', 'the same'],
      ['POST /oauth/register', 'the other way to get a token, and this client already has one'],
      ['POST /oauth/token', 'the same'],
      ['POST /feedback', 'about this service rather than about a board, and it takes no token'],
      ['GET /v1/{project}', 'read back through summary()'],
      ['GET /v1/{project}/inbox', 'read through inbox()'],
    ]);

    const source = await (await import('node:fs/promises')).readFile(
      new URL('../../../packages/sdk/src/index.ts', import.meta.url),
      'utf8',
    );
    const wrapped = new Set<string>(['POST /p']);
    for (const [, method, path] of source.matchAll(/this\.request(?:<[^>]*>)?\(\s*'([A-Z]+)',\s*[`']([^`']*)/g)) {
      wrapped.add(
        `${method} /v1/{project}${path!
          .replace(/\$\{encodeURIComponent\(slug\)\}/, '{slug}')
          .replace(/\$\{encodeURIComponent\(from\)\}/, '{handle}')
          .replace(/\$\{encodeURIComponent\(id\)\}/, '{id}')}`,
      );
    }

    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
        const call = `${method.toUpperCase()} ${path}`;
        if (wrapped.has(call) || elsewhere.has(call)) continue;
        missing.push(call);
      }
    }
    assert.deepEqual(missing, [], `the SDK cannot reach: ${missing.join(', ')}`);

    // And the reasons stay honest: a call named as deliberately absent has to
    // still exist, or the note is about nothing.
    for (const call of elsewhere.keys()) {
      const [method, path] = call.split(' ');
      assert.ok(spec.paths[path!]?.[method!.toLowerCase()], `${call} is named as absent and is not a call at all`);
    }
  });

  it('takes the next card and the lease in one call', async () => {
    const { client } = await Muster.start({ name: 'taking', actor: 'taker', baseUrl });
    await client.upsert({ slug: 'first', title: 'something to do' });
    await client.upsert({ slug: 'second', title: 'something else' });

    const taken = await client.take();
    assert.equal(taken.claimed, true, 'the lease came with it');
    assert.ok(taken.item, 'and there was something to take');
    assert.equal(taken.item!.claim?.agent, 'taker');

    // A second loop asking at the same moment gets the other card, not the
    // same one, which is the whole reason this call exists.
    const other = await client.take('second-loop');
    assert.ok(other.item);
    assert.notEqual(other.item!.slug, taken.item!.slug);

    // And nothing left to take is an answer, not a failure.
    const empty = await client.take('third-loop');
    assert.equal(empty.item, null);
    assert.equal(empty.claimed, false);

    // The look still looks: it hands back what is there without taking it.
    const looked = await client.next('fourth-loop');
    assert.equal((looked as { claimed?: boolean }).claimed, undefined);
  });

  it('withNext takes, holds and hands back, and says nothing rather than failing', async () => {
    // The pattern the README teaches, because the one it used to teach was a
    // race: `next()` then `withClaim()` offers every loop the same card.
    const { client } = await Muster.start({ name: 'the loop', actor: 'loop-a', baseUrl });
    await client.upsert({ slug: 'only', title: 'the one thing to do' });

    const held: string[] = [];
    const done = await client.withNext(async (item) => {
      const during = await client.item(item.slug);
      held.push(during.item.claim?.agent ?? '(nobody)');
      return item.slug;
    });
    assert.equal(done, 'only');
    assert.deepEqual(held, ['loop-a'], 'the lease was held while the work ran');

    const after = await client.item('only');
    assert.equal(after.item.claim, null, 'and handed back afterwards');

    // A throw still hands it back.
    await client.upsert({ slug: 'second', title: 'something that goes wrong' });
    await assert.rejects(
      client.withNext(async () => {
        throw new Error('the work failed');
      }),
      /the work failed/,
    );
    const released = await client.item('second');
    assert.equal(released.item.claim, null, 'even when the work throws');

    // Nothing left is an answer, not a failure.
    for (const slug of ['only', 'second']) {
      await client.upsert({ slug, status: 'done', note: 'finished' });
    }
    assert.equal(await client.withNext(async () => 'ran'), null);
  });

  it('sets the hygiene rules in the shape the service takes', async () => {
    // The first version of this type was guessed from the field names and got
    // `absence_resolve` wrong: it is two numbers and not one, because closing
    // work a signal stopped mentioning needs both a count of consecutive
    // absences and hours of wall clock, so one failed poll cannot close live
    // work. A caller writing the valid value would have failed type-checking,
    // and the value the type advertised would have been refused 400.
    const { client } = await Muster.start({ name: 'rules', actor: 'a', baseUrl });

    const set = await client.setRules({
      absence_resolve: { observations: 3, min_hours: 6 },
      stale_after_hours: null,
      claim_ttl_minutes: 45,
    });
    const rules = (set as { rules?: Record<string, unknown> }).rules ?? set;
    assert.deepEqual(rules.absence_resolve, { observations: 3, min_hours: 6 });
    assert.equal(rules.stale_after_hours, null, 'null turns a rule off');
    assert.equal(rules.claim_ttl_minutes, 45);

    // And the shape the old type advertised is refused, which is what makes
    // getting the type right worth doing rather than merely tidy.
    await assert.rejects(
      client.setRules({ absence_resolve: 3 as unknown as { observations: number; min_hours: number } }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        return true;
      },
    );
  });

  it('can list and revoke a key it made, and rotate a read link', async () => {
    // Minting a credential from code and having to open a browser to take it
    // back is the asymmetry that leaves keys alive forever.
    const { client, created } = await Muster.start({ name: 'keys', actor: 'a', baseUrl });
    const made = await client.createKey({ name: 'a worker', role: 'write' });
    const listed = await client.keys();
    assert.ok(listed.keys.some((key) => key.id === made.key.id), 'it can see what it made');
    assert.ok(
      !JSON.stringify(listed.keys).includes(made.token),
      'and the token is not in the list, because it is shown once',
    );

    const revoked = await client.deleteKey(made.key.id);
    assert.equal(revoked.ok, true);
    // Still on the list, with a date. A list of live keys only cannot answer
    // what happened to one that used to work, which is the question somebody
    // reading an audit is asking.
    const after = await client.keys();
    const gone = after.keys.find((key) => key.id === made.key.id);
    assert.ok(gone, 'it is still on the list');
    assert.ok(gone!.revoked_at, 'and it says when it stopped working');

    const rotated = await client.rotateReadLink();
    assert.match(rotated.read_url, /\/r\/r_/);
    assert.notEqual(rotated.read_url, created.read_url, 'the old link is not the new one');
  });

  /**
   * The types are a published promise about the responses, and they are
   * released separately from them. A field added to a serializer and not to the
   * interface is invisible: nothing fails, the package keeps working, and the
   * consumer simply cannot see the thing we added. It happened the morning
   * `notified_at` arrived.
   *
   * Read out of the two files rather than from the types, because interfaces do
   * not exist at runtime and this is the check that matters: what the server
   * puts in the object, and what the package says is in it.
   */
  it('describes every field the responses actually carry', async () => {
    const read = async (path: string) =>
      (await import('node:fs/promises')).readFile(new URL(path, import.meta.url), 'utf8');
    const serializers = await read('../src/serialize.ts');
    const types = await read('../../../packages/sdk/src/index.ts');

    const emitted = (fn: string): string[] => {
      const body = new RegExp(`export function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(
        serializers,
      );
      assert.ok(body, `no ${fn} in serialize.ts`);
      return [...body[1]!.matchAll(/^ {4}([a-z_0-9]+):/gm)].map((match) => match[1]!);
    };
    const declared = (name: string): Set<string> => {
      const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types);
      assert.ok(body, `no ${name} in the SDK`);
      return new Set([...body[1]!.matchAll(/^ {2}([a-z_0-9]+)\??:/gm)].map((match) => match[1]!));
    };

    for (const [fn, type] of [
      ['itemJson', 'Item'],
      ['escalationJson', 'Escalation'],
    ] as const) {
      const missing = emitted(fn).filter((key) => !declared(type).has(key));
      assert.deepEqual(missing, [], `${type} does not describe what ${fn} returns`);
    }
  });
});

describe('the package a fleet installs', () => {
  // `fileURLToPath`, not `.pathname`: a checkout under a directory with a
  // space in it leaves the escape in the string, and `npm` is then handed a
  // `cwd` that does not exist.
  const sdk = fileURLToPath(new URL('../../../packages/sdk/', import.meta.url));

  /**
   * Everything above this imports the source, on purpose, so a broken SDK
   * fails here rather than a stale `dist` passing quietly. That leaves the
   * thing that actually ships untested: the tarball carries `dist`, its
   * `exports` map names files that have to exist, and nothing in this suite
   * had ever loaded one of them. A package can be perfect in TypeScript and
   * unimportable on the other end.
   *
   * Built here rather than assumed, which is also what answers the comment
   * above: this cannot pass on a stale build because it makes the build.
   */
  it('builds, and the built files are the ones its manifest names', async () => {
    execFileSync('npm', ['run', 'build'], { cwd: sdk, stdio: 'ignore' });
    const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as {
      main: string;
      types: string;
      exports: Record<string, Record<string, string>>;
    };
    const named = [
      manifest.main,
      manifest.types,
      ...Object.values(manifest.exports).flatMap((entry) => Object.values(entry)),
    ];
    for (const path of named) {
      assert.ok(existsSync(join(sdk, path)), `${path} is named by package.json and is not on disk`);
    }
  });

  it('drives a session through the built entry point, the way an install would', async () => {
    // The file the manifest points at, not the one I expect it to point at.
    // An exports map moved to some other file that happens to exist passes
    // the check above and would fail on the other end of an install, which is
    // the only place that map is ever read.
    const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string }>;
    };
    const entry = pathToFileURL(join(sdk, manifest.exports['.']!.import)).href;
    const built = (await import(entry)) as { Muster: { start: (options: Record<string, unknown>) => Promise<any> } };
    assert.equal(typeof built.Muster?.start, 'function', 'the entry point exports what the docs tell people to import');

    const { client, created } = await built.Muster.start({
      name: 'from the built package',
      actor: 'errors-loop',
      baseUrl,
    });
    assert.match(created.token, /^mk_/);
    const upserted = await client.upsert({ slug: 'errors:built', title: 'filed through the tarball' });
    assert.equal(upserted.item.slug, 'errors:built');
    const read = await client.item('errors:built');
    assert.equal(read.item.title, 'filed through the tarball');
  });
});
