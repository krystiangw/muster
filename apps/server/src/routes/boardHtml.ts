import type { AgentFacet, BoardFacets, BoardFilter, BoardView } from '../board.js';
import { normalizeHandle } from '../ids.js';
import { OPERATOR_ACTOR } from '../types.js';
import { BOARD_PRESETS, COLUMN_RENDER_LIMIT, applyForColumn, unsatisfiableBy } from '../board.js';
import { boardConfigJson } from '../serialize.js';
import { chip, escapeHtml, when } from '../html.js';
import { who } from '../identity.js';
import type { ItemDoc, ProjectDoc, TimelineEntry } from '../types.js';

/**
 * The board, rendered server side.
 *
 * Columns scroll horizontally, swimlanes stack, and nothing here needs
 * JavaScript: an operator opening this on a phone at a bus stop gets the same
 * page an agent gets over curl.
 */

/**
 * Moving a card without JavaScript.
 *
 * A drag needs a script, a browser and a mouse; a select and a button need
 * none of the three, and they say out loud where the card is going, which a
 * drag never does. The destinations are the columns that declare what belongs
 * in them: a column that is a pure view has nothing to apply, so offering it
 * here would only produce an error.
 */
/**
 * The narrowing, carried through a write.
 *
 * Somebody working through one agent's queue, or one label, or a search, must
 * land back where they were. A form that dropped it would throw them to the
 * whole board on every card they touched.
 */
function keptFilter(keep: BoardFilter): string {
  // Prefixed, and that prefix is load bearing. The assign form has a visible
  // field called owner, and a hidden one of the same name would either be
  // parsed as two values of one field or, on an unfiltered board, send the
  // person somewhere new every time they assigned somebody. What is being
  // edited and where the person was standing are two different things.
  return (['owner', 'agent', 'label', 'q'] as const)
    .filter((name) => keep[name])
    .map((name) => `<input type="hidden" name="from_${name}" value="${escapeHtml(keep[name]!)}">`)
    .join('');
}

function moveForm(
  item: ItemDoc,
  from: string,
  targets: MoveTarget[],
  action: string,
  keep: BoardFilter,
): string {
  const options = targets.filter((target) => target.key !== from);
  if (options.length === 0) return '';
  return `<form class="move" method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">
    ${
      // Moving a card off a narrowed board must not throw the narrowing away:
      // somebody looking at one agent's work wants to still be there afterwards.
      keptFilter(keep)
    }
    <label class="sr-only" for="mv-${escapeHtml(from)}-${escapeHtml(item.slug)}">Move ${escapeHtml(item.slug)} to</label>
    <select id="mv-${escapeHtml(from)}-${escapeHtml(item.slug)}" name="column">
${options
  .map((target) => `      <option value="${escapeHtml(target.key)}">${escapeHtml(target.title)}</option>`)
  .join('\n')}
    </select>
    <button type="submit" title="Move this item">move</button>
  </form>`;
}

/**
 * Who is on this card, by name.
 *
 * "Agent" is not a label on a board six agents write to; the handle is. A live
 * claim is the strongest answer, and for a card nobody is holding the last
 * writer is the next best one, marked as a past tense so the two do not read
 * the same.
 */
function whoChips(item: ItemDoc, claimed: boolean, agents?: Map<string, string>): string {
  const parts: string[] = [];
  // A handle says which agent; its registered description says what that agent
  // is for, which is the thing somebody reading the board actually wants and
  // which nobody should have to look up in another view. The colour says it
  // before either is read: on a board six agents write to, "whose is this" is
  // the question every card gets asked, and a colour answers it for free.
  const named = (handle: string, prefix?: string): string =>
    who(handle, { title: agents?.get(handle), prefix });
  if (claimed) parts.push(named(item.claim!.agent));
  else if (item.lastActor) parts.push(named(item.lastActor, 'last:'));
  if (item.owner) parts.push(named(item.owner, 'owner:'));
  return parts.join(' ');
}

function card(
  item: ItemDoc,
  now: Date,
  move: string,
  open: string,
  asked: number,
  agents?: Map<string, string>,
  /** What this card is still waiting on, empty when it is waiting on nothing. */
  waiting: string[] = [],
): string {
  const claimed = item.claim !== null && new Date(item.claim.expiresAt) > now;
  const classes = ['card', item.stale ? 'is-stale' : '', claimed ? 'is-claimed' : '']
    .filter(Boolean)
    .join(' ');
  // The title is the one thing a column is too narrow for, so it is clamped to
  // two lines here and shown whole in the preview the card links to.
  return `<article class="${classes}">
  <a class="peek" href="${escapeHtml(open)}">
    <span class="slug">${escapeHtml(item.slug)}</span>
    <span class="t">${escapeHtml(item.title || '(no title)')}</span>
  </a>
  <div class="meta">
    ${whoChips(item, claimed, agents)}
    ${
      // A blocked card can sit in "In progress", because somebody holding an
      // item they cannot move is exactly what blocked means, and the columns
      // are a partition: first match wins. The chip is how the card still says
      // it, wherever the layout puts it. Anything else makes the operator's
      // "what is stuck" question unanswerable from the board.
      item.status === 'blocked' ? chip('blocked', 'blocked') : ''
    }
    ${
      // Something is waiting on the person reading this, and the card used to
      // say nothing: the question lived in the sheet behind it and on another
      // page. A board whose whole claim is "what needs a human" cannot make
      // that the one thing you have to open every card to find.
      asked > 0 ? chip(asked === 1 ? 'asks you' : `${asked} questions`, 'asks') : ''
    }
    ${item.stale ? chip('stale', 'stale') : ''}
    ${
      // Why nothing is happening to a card that looks perfectly workable.
      // Without it, a card waiting on two others sits in the same column as
      // work anybody could pick up, and the only difference is a field you
      // have to open the card to see: the board would be showing an agent
      // ignoring a ticket rather than an agent being refused it.
      //
      // Drawn from what is still unfinished rather than from the list itself.
      // The list stays on the card after its prerequisites close, because it
      // is a record of what this depended on, and a chip that outlives the
      // blocking says the opposite of the truth.
      waiting.length > 0
        ? chip(
            waiting.length === 1 ? `waiting on ${waiting[0]}` : `waiting on ${waiting.length}`,
            'blocked',
          )
        : ''
    }
    ${(item.labels ?? []).slice(0, 3).map((label) => chip(label, 'open')).join(' ')}
  </div>
  <div class="foot">
    <span class="slug">${when(item.updatedAt, now)}</span>
    ${
      // The number every queue and every column sorts by, and the card did not
      // show it at all. Signed, because higher is more urgent here and every
      // other tracker somebody has used numbers the other way round: "+3" and
      // "-2" carry the direction in the glyph. Zero is ordinary work and says
      // nothing, so a board that never sets a priority looks no busier.
      item.priority
        ? `<span class="prio" title="priority, higher is more urgent, -10 to 10">${
            item.priority > 0 ? '+' : ''
          }${item.priority}</span>`
        : ''
    }
  </div>
  ${move}
</article>`;
}

/**
 * The preview behind a card, opened by clicking it.
 *
 * It is a `:target` sheet, not a dialog: `#id` in the URL opens it, `#` closes
 * it, and the whole thing works with JavaScript switched off, which is the rule
 * the rest of these pages follow. It exists because a column is too narrow for
 * a real title, and truncating without anywhere to read the rest is a board
 * that hides what it is about.
 */
function preview(
  item: ItemDoc,
  now: Date,
  timeline: TimelineEntry[],
  agents: Map<string, string> | undefined,
  edit: string,
  asked: string,
  close: string,
): string {
  const claimed = item.claim !== null && new Date(item.claim.expiresAt) > now;
  // `open` beside `:target`, because the two mechanisms answer to different
  // things: the fragment is what a browser does for free, and the class is what
  // a page rendered with `?card=` can promise without one.
  return `<div class="peeked${close === '#' ? '' : ' open'}" id="${escapeHtml(item._id)}">
  <a class="scrim" href="${escapeHtml(close)}" aria-label="Close"></a>
  <div class="sheet">
    <div class="sheet-top">
      <span class="slug">${escapeHtml(item.slug)}</span>
      <a class="close" href="${escapeHtml(close)}">close</a>
    </div>
    <h2>${escapeHtml(item.title || '(no title)')}</h2>
    <div class="meta">
      ${chip(item.status, item.status)}
      ${whoChips(item, claimed, agents)}
      ${item.stale ? chip('stale', 'stale') : ''}
      ${item.source ? chip(`from ${item.source}`, 'note') : ''}
      ${
        item.priority
          ? `<span class="chip note" title="higher is more urgent, -10 to 10">priority ${
              item.priority > 0 ? '+' : ''
            }${item.priority}</span>`
          : ''
      }
      ${(item.labels ?? []).map((label) => chip(label, 'open')).join(' ')}
    </div>
    ${item.body ? `<p class="body">${escapeHtml(item.body)}</p>` : '<p class="none">No description. Whoever picks this up should write one.</p>'}
    ${
      claimed
        ? `<p class="why">Held by ${escapeHtml(item.claim!.agent)}, lease expires ${when(
            item.claim!.expiresAt,
            now,
          )}.</p>`
        : ''
    }
    ${
      // What an agent will be refused over. Printed as the slugs it was given
      // rather than as their statuses, because the person reading this wants
      // the names to look for on the board; whether each is finished is on the
      // card it belongs to.
      (item.blockedBy ?? []).length > 0
        ? `<p class="why">Waiting on ${(item.blockedBy ?? [])
            .map((slug) => `<code>${escapeHtml(slug)}</code>`)
            .join(', ')}. An agent asking for work is not offered this one until they are done.</p>`
        : ''
    }
    ${
      timeline.length > 0
        ? `<ul class="timeline">
${timeline
  .map(
    (entry) => `      <li><span class="when">${when(entry.at, now)}</span>
        <span class="who${entry.by === 'hygiene' ? ' hygiene' : ''}">${
          entry.by === 'hygiene' ? escapeHtml(entry.by) : who(entry.by)
        }</span>
        <span>${escapeHtml(entry.message)}</span></li>`,
  )
  .join('\n')}
    </ul>`
        : ''
    }
    ${asked}
    ${edit}
    <p class="why">updated ${when(item.updatedAt, now)} &middot; created ${when(item.createdAt, now)} &middot; ${item.timelineCount} timeline entr${item.timelineCount === 1 ? 'y' : 'ies'}</p>
  </div>
</div>`;
}

/**
 * Assigning somebody, and tagging.
 *
 * In the sheet rather than on the card, because a card is read at a glance and
 * a column is 230px wide: the face of a card is for scanning, the sheet behind
 * it is where somebody does something. Both are plain forms, so the board keeps
 * working with scripting switched off, and both carry the current narrowing so
 * acting on a card does not throw you back to the whole board.
 *
 * The owner field is an input with a datalist rather than a select: the people
 * a board already knows are one keystroke away, and somebody new can still be
 * named without an administrator adding them first.
 *
 * The words themselves are behind a fold, because correcting a title is rarer
 * than adding to it and a form that rewrites what an agent wrote should not be
 * the first thing a hand lands on. A note is added to the record; an edit
 * replaces part of it, and the difference is worth one click.
 *
 * It carries what it was showing, so the route can write only what this person
 * changed and refuse the rest: two people share this card by construction, and
 * a form that posts everything it was rendered with undoes whatever the other
 * one wrote in between.
 *
 * And a note, because until this existed a person could move a card, assign it
 * and tag it, and could not say why. The whole product is a board agents and
 * people share; a share where one side may only rearrange what the other side
 * wrote is not one. What is typed here lands in the same timeline an agent
 * writes to, under `operator`, and every agent that reads the item sees it.
 */
/**
 * The urgency scale, in words a person can pick from.
 *
 * The number is the real thing and every queue here sorts by it, but a board is
 * read by somebody who does not want to learn that -10 to 10 exists before they
 * can say "this one first". The values are spread rather than consecutive so
 * there is room left for an agent to file something between two of them.
 *
 * An item filed from the board with no urgency is ordinary work, which is what
 * an agent filing without a priority also gets, so the two doors agree.
 */
const PRIORITIES: Array<{ value: number; title: string }> = [
  { value: 5, title: 'urgent (+5)' },
  { value: 2, title: 'next (+2)' },
  { value: 0, title: 'ordinary (0)' },
  { value: -3, title: 'when there is time (-3)' },
];

/**
 * The four points, plus wherever this item actually is.
 *
 * An agent files at any number on the scale, so a card at +7 met a list that
 * did not contain it: the browser then shows the first option, and a person who
 * touches nothing but presses the button beside it has just moved that item
 * from +7 to +5 without being told. A value that is not one of the four is
 * offered as itself, in its own place in the order.
 */
function priorityOptions(current: number): string {
  const levels = PRIORITIES.some((level) => level.value === current)
    ? PRIORITIES
    : [...PRIORITIES, { value: current, title: `${current > 0 ? '+' : ''}${current}` }].sort(
        (a, b) => b.value - a.value,
      );
  return levels
    .map(
      (level) =>
        `<option value="${level.value}"${level.value === current ? ' selected' : ''}>${escapeHtml(
          level.title,
        )}</option>`,
    )
    .join('');
}

function editForms(item: ItemDoc, facets: BoardFacets, action: string, keep: BoardFilter): string {
  const id = escapeHtml(item._id);
  const labels = item.labels ?? [];
  return `<div class="edit">
  <form class="row" method="post" action="${escapeHtml(action)}/owner">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
    <label for="own-${id}">Owner
      <input id="own-${id}" name="owner" list="owners-${id}" size="14"
        value="${escapeHtml(item.owner ?? '')}" placeholder="nobody">
    </label>
    <datalist id="owners-${id}">
      ${facets.owners.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}
    </datalist>
    <button type="submit">assign</button>
  </form>
  <form class="row" method="post" action="${escapeHtml(action)}/labels">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
    <label for="lab-${id}">Add label
      <input id="lab-${id}" name="add" list="labels-${id}" size="14" placeholder="label">
    </label>
    <datalist id="labels-${id}">
      ${facets.labels.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('')}
    </datalist>
    <button type="submit">tag</button>
  </form>
  <form class="row" method="post" action="${escapeHtml(action)}/priority">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
    <label for="pri-${id}">Urgency
      <select id="pri-${id}" name="priority">
        ${priorityOptions(item.priority ?? 0)}
      </select>
    </label>
    <button type="submit">set</button>
  </form>
  <details class="rewrite">
    <summary>Edit the words</summary>
    <form method="post" action="${escapeHtml(action)}/edit">
      <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
      <input type="hidden" name="was_title" value="${escapeHtml(item.title ?? '')}">
      <input type="hidden" name="was_body" value="${escapeHtml(item.body ?? '')}">
      <label for="title-${id}">Title</label>
      <input id="title-${id}" name="title" maxlength="200" value="${escapeHtml(item.title ?? '')}">
      <label for="body-${id}">Description</label>
      <textarea id="body-${id}" name="body" rows="4" maxlength="4000">${escapeHtml(item.body ?? '')}</textarea>
      <button type="submit">save</button>
    </form>
  </details>
  <form class="row" method="post" action="${escapeHtml(action)}/waiting">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
    <label for="wait-${id}">Waiting on
      <input id="wait-${id}" name="waiting" list="slugs-${id}" size="22"
        value="${escapeHtml((item.blockedBy ?? []).join(' '))}" placeholder="nothing">
    </label>
    <datalist id="slugs-${id}">
      ${facets.slugs
        .filter((slug) => slug !== item.slug)
        .map((slug) => `<option value="${escapeHtml(slug)}"></option>`)
        .join('')}
    </datalist>
    <button type="submit">set</button>
  </form>
  <form class="note" method="post" action="${escapeHtml(action)}/note">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
    <label for="note-${id}">Add a note</label>
    <textarea id="note-${id}" name="message" rows="2" maxlength="2000"
      placeholder="What you know that the agents do not."></textarea>
    <button type="submit">add note</button>
  </form>
  ${
    labels.length === 0
      ? ''
      : `<div class="row tags">${labels
          .map(
            (label) => `<form method="post" action="${escapeHtml(action)}/labels">
      <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">${keptFilter(keep)}
      <input type="hidden" name="remove" value="${escapeHtml(label)}">
      <button class="ghost tag" type="submit" title="Remove this label">${escapeHtml(label)} &times;</button>
    </form>`,
          )
          .join('')}</div>`
  }
</div>`;
}

interface MoveTarget {
  key: string;
  title: string;
}

export interface BoardQuestion {
  id: string;
  agent: string;
  question: string;
  context: string;
}

/**
 * The question on the card it was asked about, with the same four answers the
 * other page offers.
 *
 * The same form, deliberately: two forms for one decision drift, and the one
 * that drifts is always the one somebody found second.
 */
function questionForm(question: BoardQuestion, action: string, keep: BoardFilter): string {
  return `<div class="asked">
  <p class="label">${escapeHtml(question.agent)} is waiting on you</p>
  <p style="font-size:16px;margin:0 0 6px"><b>${escapeHtml(question.question)}</b></p>
  ${question.context ? `<p class="why" style="white-space:pre-wrap">${escapeHtml(question.context)}</p>` : ''}
  <form method="post" action="${escapeHtml(action)}/escalations/${escapeHtml(question.id)}">
    <input type="hidden" name="back" value="board">${keptFilter(keep)}
    <label>Your answer
      <textarea name="answer" rows="2" placeholder="The decision, in your words."></textarea>
    </label>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button type="submit" name="status" value="answered">Answer</button>
      <button class="ghost" type="submit" name="status" value="resolved">Already handled</button>
      <button class="ghost" type="submit" name="status" value="wont_do">Won't do</button>
      <button class="ghost" type="submit" name="status" value="in_progress">I'm on it</button>
    </div>
  </form>
</div>`;
}

export interface BoardRenderOptions {
  now?: Date;
  /** Where the per-card move form posts. Omitted renders a read-only board. */
  moveAction?: string;
  /** Shown once above the board, after a move that did not land where it was sent. */
  notice?: string;
  /** Last timeline entries per item id, for the previews. */
  timelines?: Map<string, TimelineEntry[]>;
  /** Rendered above the board when it can be narrowed by owner or agent. */
  filters?: string;
  /** Agent handle to its registered description, shown on the handle itself. */
  agents?: Map<string, string>;
  /** Names already in use, offered in the assign and tag fields. */
  facets?: BoardFacets;
  /**
   * Open questions by the slug they were asked about, so the card carries the
   * question and the answer form.
   *
   * A question about an item used to live only on the other page, and a person
   * who opened the card it named saw a card with nothing to say and no way to
   * reply. What waits on somebody has to be answerable where they meet it.
   */
  questions?: Map<string, BoardQuestion[]>;
  /** Where an answer posts, when questions are offered. */
  answerAction?: string;
  /**
   * This project's id, for the one sentence that has to name it: the person
   * looking at an empty board has to tell an agent which board to write to,
   * and the protocol document cannot know. Absent on the demonstration, which
   * belongs to nobody.
   */
  projectId?: string;
  /**
   * The slugs whose blockers are not finished yet, so the card can say which
   * of them is actually stuck.
   *
   * A card keeps the list it was given after its prerequisites close, which is
   * right: the list is a record of what this depended on. What the board must
   * not do is keep calling that card blocked, because by then anybody may take
   * it and the chip would be pointing at the wrong thing.
   */
  waiting?: Map<string, string[]>;
  /**
   * Said above the board when a search was dropped for reading too long.
   *
   * The board below it is the whole board, not the search. Rendering the search
   * as if it had answered nothing would be the page saying there is nothing to
   * find, which is the one thing a stopped search did not establish.
   */
  searchStopped?: string;
  /**
   * The board's own URL, which turns the sheets from fragments into addresses.
   *
   * A card sheet used to be a `#id` target, which the server never sees. That
   * was fine until the board started reloading itself once a minute: a person
   * halfway through a note lost it to a refresh nobody asked for, and no
   * server can hold a page still for a state it is not told about.
   */
  boardUrl?: string;
  /**
   * The card whose sheet is open, when the board is addressed.
   *
   * The item itself rather than its slug, because the card an address names is
   * not always one the board is holding: a column keeps fifty and draws
   * fifteen, and a link sent last week outlives both. The route resolves it,
   * from the board when it is there and from the collection when it is not.
   */
  openItem?: ItemDoc | null;
}

/** Every narrowing in force, in words, for the line above the board. */
function narrowedTo(view: BoardView): string[] {
  return [
    view.filter.owner ? `owner ${view.filter.owner}` : '',
    view.filter.agent ? `agent ${view.filter.agent}` : '',
    view.filter.label ? `label ${view.filter.label}` : '',
    view.filter.q ? `"${view.filter.q}"` : '',
  ].filter(Boolean);
}

export function renderBoard(view: BoardView, options: BoardRenderOptions = {}): string {
  const now = options.now ?? new Date();
  // Where a sheet lives. With a board URL it is an address: the server knows
  // which card is open, which is what lets it hold the page still while
  // somebody types into it, and what keeps the page from carrying a form for
  // every card on the board. Without one, the fragment does what it always did,
  // which is what the demonstration on the front page runs on.
  const addressed = typeof options.boardUrl === 'string';
  const sheetUrl = (item: ItemDoc) =>
    addressed
      ? `${narrowedUrl(options.boardUrl!, view.filter, { card: item.slug })}#${item._id}`
      : `#${item._id}`;
  const closeUrl = addressed
    ? narrowedUrl(options.boardUrl!, view.filter, { card: undefined })
    : '#';
  const targets: MoveTarget[] = options.moveAction
    ? view.config.columns
        .filter(
          (column) =>
            Object.keys(applyForColumn(column)).length > 0 &&
            // And nothing it asks for that a move cannot set. Offering those
            // put a card somewhere else and explained afterwards, which is a
            // control that lies at the moment somebody uses it.
            unsatisfiableBy(column).length === 0,
        )
        .map((column) => ({ key: column.key, title: column.title }))
    : [];
  const lanes = view.rows.length > 0 ? view.rows : [{ key: '', title: '', columns: [] }];
  const shown = lanes.flatMap((lane) =>
    lane.columns.flatMap((cell) => cell.items.slice(0, COLUMN_RENDER_LIMIT)),
  );
  // The sheets, which are not the same list as the cards: a column draws its
  // first fifteen, and an address names one card wherever it has got to.
  const sheets = addressed ? (options.openItem ? [options.openItem] : []) : shown;
  // Above the board, not below it: a column is taller than a screen, and a
  // confirmation nobody scrolls to is not a confirmation.
  return `${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ''}
${options.searchStopped ? `<p class="notice warn">${escapeHtml(options.searchStopped)}</p>` : ''}
${options.filters ?? ''}
${
    // Every way of narrowing, not only two of the four. A search or a label
    // that matched nothing used to produce four empty columns and no sentence,
    // which reads as an empty board rather than as an empty result.
    narrowedTo(view).length > 0
      ? `<p class="notice"><b>Narrowed to ${escapeHtml(narrowedTo(view).join(' and '))}.</b> ${
          shown.length === 0
            ? 'Nothing matches.'
            : 'The counts below are of that work, not of the whole board.'
        }</p>`
      : `${
          // A board nobody has written to yet is four boxes saying "empty",
          // which reads as broken rather than as new. This is often the first
          // page a person sees, handed to them before the agent has written
          // anything at all.
          //
          // Empty means the project is empty, not that this layout drew
          // nothing: a board whose columns match none of its items has work on
          // it, says so in the warning below, and must not also be told that
          // nobody has written here.
          view.scanned === 0
            ? `<p class="notice">Nothing on this board yet. It fills in when an agent writes its
first item, and the columns below are already waiting for the work.${
                // What the sentence used to leave out, which made it advice
                // that produces a second board: the protocol starts by
                // creating a project, so an agent sent there without this
                // one's name signs up again and writes somewhere else.
                options.projectId
                  ? ` To point an agent at <em>this</em> board, give it
<a href="/skill.md">skill.md</a>, the project <span class="mono">${escapeHtml(options.projectId)}</span>
and the token you were shown when it was created. The token is not on this page and never will be:
this link is for reading and answering, not for writing as an agent.`
                  : ` If the agent that should be writing here has not been told where to write,
everything it needs is one page: <a href="/skill.md">skill.md</a>.`
              }</p>`
            : ''
        }`
  }
${
    // What the columns hold, in one line. On a phone the board is a strip two
    // hundred pixels wide that scrolls sideways, so "is anything blocked" took
    // three swipes to answer.
    lanes.length === 1 && lanes[0]!.columns.length > 0
      ? `<p class="tally">${lanes[0]!.columns
          .map((cell) => `${escapeHtml(cell.title)} <b>${cell.count}</b>`)
          .join(' &middot; ')}</p>`
      : ''
  }
<div class="board">
${lanes
  .map(
    (lane) => `<div class="lane">
  ${lane.title ? `<div class="lane-title">${escapeHtml(lane.title)}</div>` : ''}
  <div class="cols">
${lane.columns
  .map(
    (cell) => `    <section class="col">
      <header><h2>${escapeHtml(cell.title)}</h2><span class="n">${cell.count}</span></header>
      ${cell.hint ? `<p class="why">${escapeHtml(cell.hint)}</p>` : ''}
      ${
        cell.items.length === 0
          ? '<p class="none">empty</p>'
          : cell.items
              .slice(0, COLUMN_RENDER_LIMIT)
              .map((item) =>
                card(
                  item,
                  now,
                  options.moveAction
                    ? moveForm(item, cell.key, targets, options.moveAction, view.filter)
                    : '',
                  sheetUrl(item),
                  options.questions?.get(item.slug)?.length ?? 0,
                  options.agents,
                  options.waiting?.get(item.slug) ?? [],
                ),
              )
              .join('\n')
      }
      ${
        cell.count > Math.min(cell.items.length, COLUMN_RENDER_LIMIT)
          ? `<p class="more">and ${cell.count - Math.min(cell.items.length, COLUMN_RENDER_LIMIT)} more</p>`
          : ''
      }
    </section>`,
  )
  .join('\n')}
  </div>
</div>`,
  )
  .join('\n')}
</div>
${
    view.unplaced > 0
      ? `<p class="notice warn"><b>${view.unplaced} item(s) match no column.</b> A board that hides work is
         worse than no board: widen a column, or add one for them.</p>`
      : ''
  }
${
    view.partial
      ? '<p class="notice warn">This board has more items than one page reads, so the counts are partial.</p>'
      : ''
  }
${sheets
  .map((item) =>
    preview(
      item,
      now,
      options.timelines?.get(item._id) ?? [],
      options.agents,
      options.moveAction && options.facets
        ? editForms(item, options.facets, options.moveAction.replace(/\/move$/, ''), view.filter)
        : '',
      // Every open question on this card, not the last one to be read off the
      // list: two agents can be waiting on the same item, and showing one of
      // them hides the other until this one is answered.
      options.answerAction
        ? (options.questions?.get(item.slug) ?? [])
            .map((question) => questionForm(question, options.answerAction!, view.filter))
            .join('\n')
        : '',
      closeUrl,
    ),
  )
  .join('\n')}`;
}

/**
 * Filing a card, from the board.
 *
 * The UI grew read first: agents wrote the work and people read it, moved it
 * and answered questions about it. Nobody decided that a person may not file
 * anything, it simply was never built, and the result was an operator with a
 * board full of work and a curl command as the only way to add to it.
 *
 * A slug is derived from the title rather than asked for. It is an idempotency
 * key an agent needs and a piece of jargon a person should never have to meet,
 * and the route keeps it from landing on top of an existing card.
 *
 * The description is optional and says what happens when it is left out,
 * because on most boards the hygiene rule drops an item nobody described.
 */
export function renderNewItem(
  action: string,
  requireBodyAfterHours: number | null,
  keep: BoardFilter = {},
  open = false,
): string {
  // Addressed like a card sheet, and for the same reason: this is the longest
  // thing anybody types on this page, and a board that reloads itself under a
  // half written description is a board that eats it.
  const openUrl = narrowedUrl(action, keep, { new: '1' });
  const closeUrl = narrowedUrl(action, keep, { new: undefined });
  return `<p class="addcard"><a class="btn" href="${escapeHtml(openUrl)}#new-item">Add an item</a></p>
${
    open
      ? `<div class="peeked open" id="new-item">
  <a class="scrim" href="${escapeHtml(closeUrl)}" aria-label="Close"></a>
  <div class="sheet">
    <div class="sheet-top">
      <span class="slug">new item</span>
      <a class="close" href="${escapeHtml(closeUrl)}">close</a>
    </div>
    <h2 class="minor">Add an item</h2>
    <form class="newitem" method="post" action="${escapeHtml(action)}/new">
      <label for="new-title">Title</label>
      <input id="new-title" name="title" maxlength="200" required placeholder="What needs doing">
      <label for="new-priority">Urgency</label>
      <select id="new-priority" name="priority">
        ${priorityOptions(0)}
      </select>
      <label for="new-body">Description</label>
      <textarea id="new-body" name="body" rows="4" maxlength="4000"
        placeholder="What it is, in enough words that whoever picks it up knows."></textarea>
      ${
        requireBodyAfterHours === null
          ? ''
          : `<p class="why">Left without a description, this board drops it after ${requireBodyAfterHours}h.</p>`
      }
      <button type="submit">add</button>
    </form>
  </div>
</div>`
      : ''
  }`;
}

/**
 * A URL for this board with one thing changed.
 *
 * Used by the sheets rather than by the filters now: the filter bar is a form
 * of fields with a list behind each, so what it sends is whatever is in the
 * boxes when somebody presses Enter.
 */
function narrowedUrl(
  action: string,
  filter: BoardFilter,
  change: Partial<Record<'owner' | 'agent' | 'label' | 'q' | 'card' | 'new', string | undefined>>,
): string {
  const next: Record<string, string | undefined> = { ...filter, ...change };
  const params = new URLSearchParams();
  // Which sheet is open is not part of the narrowing and is never in `filter`:
  // `card` and `new` only ever arrive in `change`, so a filter chip built from
  // the current view closes the sheet, and a link that opens one keeps the
  // narrowing. They are two parameters rather than two values of one, because
  // `new` is a slug a card can really have.
  for (const key of ['owner', 'agent', 'label', 'q', 'card', 'new'] as const) {
    const value = next[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query === '' ? action : `${action}?${query}`;
}

export function renderBoardFilters(view: BoardView, facets: BoardFacets, action: string): string {
  if (facets.owners.length === 0 && facets.agents.length === 0 && facets.labels.length === 0) {
    return '';
  }
  const filter = view.filter;
  const narrowed = Boolean(filter.owner || filter.agent || filter.label || filter.q);
  // A name somebody reached this board by is offered even when it is not on the
  // list any more, so what turned the filter on can turn it off.
  const withCurrent = (values: string[], current: string | undefined) =>
    current && !values.includes(current) ? [current, ...values] : values;

  /**
   * One field, with the names this board already knows behind it.
   *
   * A row of links applied itself on one click and cost a row per name; on a
   * board with thirty labels that is most of the screen before the first card.
   * A field with a list is what the operator asked for: the names are one
   * keystroke away, a name nobody has used yet can still be typed, and the
   * value in force is in the box rather than somewhere in a row.
   */
  const field = (
    key: 'owner' | 'agent' | 'label',
    title: string,
    empty: string,
    options: Array<{ value: string; note?: string }>,
    omitted: number,
  ): string => {
    if (options.length === 0) return '';
    const id = `filter-${key}`;
    return `  <label for="${id}">${escapeHtml(title)}
    <input id="${id}" name="${key}" list="${id}-list" size="14"
      value="${escapeHtml(filter[key] ?? '')}" placeholder="${escapeHtml(empty)}">
  </label>
  <datalist id="${id}-list">
${options
  .map(
    (option) =>
      `    <option value="${escapeHtml(option.value)}">${
        option.note ? escapeHtml(option.note) : ''
      }</option>`,
  )
  .join('\n')}
  </datalist>${
    omitted === 0
      ? ''
      : `\n  <span class="hint">${omitted} more ${key}s exist than this list holds.</span>`
  }`;
  };

  // Every field in one form, so Enter anywhere applies the lot and there is no
  // button to press after choosing, which is what the operator asked for when
  // the "show" button went.
  return `<form class="filters" method="get" action="${escapeHtml(action)}">
${field(
    'owner',
    'Owner',
    'anyone',
    withCurrent(facets.owners, filter.owner).map((value) => ({ value })),
    facets.omitted.owners,
  )}
${field(
    'agent',
    'Agent',
    'any agent',
    withCurrent(
      facets.agents.map((agent) => agent.handle),
      filter.agent,
    ).map((handle) => {
      const agent = facets.agents.find((entry) => entry.handle === handle);
      const registered = agent?.registered === true;
      // What the agent is for rides along as the option's label, which is what
      // a browser shows beside the handle in the list: a handle is a line
      // number and the description is the name.
      if (normalizeHandle(handle) === OPERATOR_ACTOR) {
        return { value: handle, note: 'written from this page, by a person' };
      }
      return {
        value: handle,
        note: registered
          ? agent && agent.description !== ''
            ? agent.description
            : 'registered here'
          : 'seen on items, not registered here',
      };
    }),
    facets.omitted.agents,
  )}
${field(
    'label',
    'Label',
    'any label',
    withCurrent(facets.labels, filter.label).map((value) => ({ value })),
    facets.omitted.labels,
  )}
  <label for="filter-q">Find
    <input id="filter-q" type="search" name="q" size="20"
      value="${escapeHtml(filter.q ?? '')}" placeholder="slug or title">
  </label>
  <span class="hint">Pick or type, then Enter.</span>
  ${
    // A form with several fields and no submit button does not submit on
    // Enter: the rule is one field, or a button. The button is off screen
    // rather than absent, because the operator asked for no button to press
    // and every browser needs one to exist for Enter to mean apply.
    ''
  }<button class="sr-only" type="submit">Apply the filter</button>
${
    narrowed
      ? `  <a class="reset" href="${escapeHtml(action)}">Clear filters</a>`
      : ''
  }
</form>`;
}

function renderAgentMerge(facets: BoardFacets, action: string, keep: BoardFilter): string {
  // Not the door. A person's own writes are signed with it, and offering it
  // here as a name to consolidate is offering to file everything a human did
  // under a loop, on the control built to undo exactly that kind of mixing.
  const agents = facets.agents.filter(
    // Normalised, like the rename it feeds: an item written by `Operator`
    // survives an exact comparison and is then offered as a merge that always
    // fails, which is a control that lies about what it can do.
    (agent) => normalizeHandle(agent.handle) !== OPERATOR_ACTOR,
  );
  if (agents.length < 2) return '';
  const options = (selected: string) =>
    agents
      .map(
        (agent) =>
          `<option value="${escapeHtml(agent.handle)}"${
            agent.handle === selected ? ' selected' : ''
          }>${escapeHtml(agent.handle)}${agent.registered ? '' : ' (seen, not registered)'}</option>`,
      )
      .join('');
  return `<h2 class="minor">Two names, one agent</h2>
<p class="why">Moves every item whose last writer was the first name, and any claim it holds, onto
the second. The timelines keep what they said, because an agent calling itself that is what
happened; the old name is kept on the agent so an old entry can still be read.</p>
<form class="row" method="post" action="${escapeHtml(action)}/agent-rename">
  ${keptFilter(keep)}
  <label for="merge-from">This name
    <select id="merge-from" name="from">${options('')}</select>
  </label>
  <label for="merge-to">is really
    <select id="merge-to" name="to">${options('')}</select>
  </label>
  <button type="submit">merge</button>
</form>`;
}

export function renderBoardSettings(
  project: ProjectDoc,
  view: BoardView,
  action: string,
  warnings: string[] = [],
  facets?: BoardFacets,
): string {
  const current = JSON.stringify(boardConfigJson(view.config), null, 2);
  // Folded shut. The layout is set once in a project's life and the board is
  // read on every visit, and this section is five screens long on a phone: an
  // editor, three presets and a reference table, all of it under the board it
  // configures. A warning about the layout is the exception and stays outside,
  // because a warning nobody opens is not a warning.
  return `${warnings
    .map((warning) => `<div class="notice warn">${escapeHtml(warning)}</div>`)
    .join('\n')}
<details class="layout">
<summary>Layout: columns, swimlanes and presets</summary>
${facets ? renderAgentMerge(facets, action, view.filter) : ''}
${
    // Said here rather than above the board. It answers one question, asked
    // once by whoever writes the layout: why is my column missing from the
    // move control. As a warning on the board it would nag every visitor about
    // a column that is working exactly as intended, including in the presets
    // this project ships.
    (() => {
      const views = view.config.columns
        .map((column) => ({ column, reasons: unsatisfiableBy(column) }))
        .filter((entry) => entry.reasons.length > 0);
      if (views.length === 0) return '';
      return `<p class="why">Views, not destinations: ${views
        .map(
          (entry) =>
            `<b>${escapeHtml(entry.column.title)}</b> asks for ${escapeHtml(
              entry.reasons.join(', and '),
            )}`,
        )
        .join('; ')}. No move can set that, so the board leaves those columns out of the move
control and cards reach them by being what the filter describes. Declare "apply" on one to say
what putting a card there should mean.</p>`;
    })()
  }
<p>A column is a name and a filter over what an item already is: its status, its labels, its owner,
whether somebody holds it, whether it went stale, where it came from. There is deliberately no way
to invent a status here. That is what keeps a board with six columns from turning into six values
every agent has to learn.</p>

<form method="post" action="${escapeHtml(action)}">
  <label>Columns and swimlanes, as JSON
    <textarea name="board" rows="18" spellcheck="false">${escapeHtml(current)}</textarea>
  </label>
  <div><button type="submit">Save layout</button></div>
</form>

<h2 class="minor">Start from one of these</h2>
<div class="grid">
${Object.entries(BOARD_PRESETS)
  .map(
    ([key, preset]) => `  <form method="post" action="${escapeHtml(action)}" class="card">
    <p class="label">${escapeHtml(preset.title)}</p>
    <p style="font-size:14px;color:var(--ink-2);margin:0 0 10px">${escapeHtml(preset.description)}</p>
    <p class="mono" style="color:var(--muted);margin:0 0 10px">${preset.config.columns
      .map((column) => escapeHtml(column.title))
      .join(' · ')}${preset.config.rows === 'none' ? '' : ` · lanes by ${preset.config.rows}`}</p>
    <input type="hidden" name="preset" value="${escapeHtml(key)}">
    <div><button class="ghost" type="submit">Use this</button></div>
  </form>`,
  )
  .join('\n')}
</div>

<h2 class="minor">What a filter can say</h2>
<div class="scroll"><table>
<thead><tr><th scope="col">Key</th><th scope="col">Meaning</th></tr></thead>
<tbody>
<tr><td class="mono">status</td><td>Any of <code>open</code>, <code>blocked</code>, <code>done</code>, <code>dropped</code>.</td></tr>
<tr><td class="mono">claimed</td><td><code>true</code> for items somebody holds right now, <code>false</code> for free ones. An expired claim counts as free.</td></tr>
<tr><td class="mono">labels / not_labels</td><td>Carries any of these labels, or none of them.</td></tr>
<tr><td class="mono">owner</td><td>Any of these owners.</td></tr>
<tr><td class="mono">stale</td><td>Whether hygiene has flagged it as untouched.</td></tr>
<tr><td class="mono">source</td><td>For items mirrored from a scanner or an error stream.</td></tr>
<tr><td class="mono">priority_min</td><td>Priority at or above this number. Higher is more urgent: the scale runs -10 to 10, 0 is ordinary work.</td></tr>
<tr><td class="mono">within_days</td><td>Only work touched in the last N days. What a "Done" column wants: finished work is worth reading, and all of it for ever is a landfill. Nothing is deleted, and the rest is one search away.</td></tr>
<tr><td class="mono">fields</td><td>Values kept from another system, e.g. <code>{"legacy_status":["investigating","fix_planned"]}</code>.</td></tr>
</tbody></table></div>
<p>An item lands in the <b>first</b> column that matches, so order the columns the way you read them.
Anything that matches nothing is reported above the board rather than hidden.</p>

<h2 class="minor">What a move does</h2>
<p>By default, the column's own filter read back at it: the one status it asks for, the first label
it requires, every label it excludes, the one owner it names, a claim where it asks for held items,
a release where it asks for free ones, and a touch where it asks for work that is not stale.
Declaring <code>apply</code> replaces that reading entirely, so spell out everything the move should
do, not only the part the filter got wrong. It also takes the column off the list of views above:
the declaration is the author's word on what belongs here, and where the filter still asks for more
than the move can set, the reply says which column the card actually landed in.</p>
<div class="scroll"><table>
<thead><tr><th scope="col">Key</th><th scope="col">What moving a card here does</th></tr></thead>
<tbody>
<tr><td class="mono">status</td><td>Sets the status. The same four; a column cannot invent one.</td></tr>
<tr><td class="mono">add_labels</td><td>Labels put on. Applied in the database, so a move never overwrites a label somebody else set meanwhile.</td></tr>
<tr><td class="mono">remove_labels</td><td>Labels taken off, the same way.</td></tr>
<tr><td class="mono">owner</td><td>Sets the owner. <code>null</code> leaves it to nobody.</td></tr>
<tr><td class="mono">priority</td><td>Sets the priority, -10 to 10.</td></tr>
<tr><td class="mono">claim</td><td><code>true</code> takes the lease in the mover's name, and the move is refused if somebody else is holding the card.</td></tr>
<tr><td class="mono">release</td><td><code>true</code> hands the lease back. One column cannot do both.</td></tr>
<tr><td class="mono">touch</td><td>Only <code>true</code>. Names the write every move already makes, the one that clears the stale flag. A column asking for <code>"stale": false</code> derives it by itself; it has a name so that a move which changes nothing else still counts as a move.</td></tr>
</tbody></table></div>
<p>A column with nothing to apply is a view. The board leaves it out of the move control, and a move
sent straight to the API is refused rather than quietly doing nothing.</p>
<p class="mono" style="color:var(--muted)">Same thing over the API:
PUT ${escapeHtml(project._id ? `/v1/${project._id}/board` : '/v1/{project}/board')}</p>
</details>`;
}
