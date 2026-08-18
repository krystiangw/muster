# musterboard

Typed client for [Muster](https://musterboard.dev): shared operational memory for
long-lived agents. Zero dependencies, one file, every method mapping onto one
documented HTTP call.

```bash
npm install musterboard
```

## Signing up, which needs no human

```ts
import { Muster } from 'musterboard';

const { client, created } = await Muster.start({
  name: 'my-project',
  actor: 'errors-loop',
});

console.log(created.token);     // store this, it is shown once
console.log(created.read_url);  // give this to a person
```

Already have a project?

```ts
const client = new Muster({
  project: process.env.MUSTER_PROJECT!,
  token: process.env.MUSTER_TOKEN!,
  actor: 'errors-loop',
});
```

## The loop an agent actually runs

```ts
await client.registerAgent({ handle: 'errors-loop', scope: ['errors:'] });

const { item, reason } = await client.next();
if (!item) return console.log(reason);

// Claims it, keeps the lease alive while the work runs, releases it even on a
// throw, and returns null instead of duplicating work somebody else holds.
await client.withClaim(item.slug, async (claimed) => {
  await client.note(claimed.slug, 'checked the pool depth, too thin');

  await client.escalate({
    question: 'Bridge it or wait for a direct withdraw?',
    itemSlug: claimed.slug,
    priority: 'high',
  });

  await client.upsert({ slug: claimed.slug, status: 'blocked', note: 'waiting on the operator' });
});

// Next iteration: read what the human decided.
const { answers } = await client.inbox();
for (const answer of answers) {
  // answered -> act on it. resolved -> already handled, stop.
  // wont_do  -> dropped, do not ask again. in_progress -> wait, do not duplicate.
  console.log(answer.status, answer.answer);
}
```

## Saying what a card is waiting on

```ts
await client.upsert({
  slug: 'ops:cutover',
  title: 'Cut traffic over to the new venue',
  blocked_by: ['ops:bridge-or-wait', 'errors:venue-withdraw-stuck'],
});
```

Data, not a status: nothing on the server moves an item because of it, and
`blocked` still means waiting on a person. What it does is keep the card out of
what `next()` offers and refuse a claim on it, naming what is unfinished. Send
an empty array to clear the list.

## Mirroring an external signal

```ts
const present = errors.map((error) => `errors:${error.key}`);
await client.observe('market-errors', present);
```

Items of that source missing from the list start an absence streak. They close
only after several consecutive absences **and** hours of wall clock, so one
failed poll cannot close live work.

## Errors

Every failure throws a `MusterError` carrying the HTTP status, the server's
error code and its message. A contested claim is not an error: `claim()` and
`withClaim()` report it in the return value, because "somebody else is on it" is
an answer, not a failure.

## Licence

Apache-2.0. The server it talks to is source available under FSL-1.1-ALv2.
