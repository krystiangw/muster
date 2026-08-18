import type { AgentFacet, BoardFacets, BoardFilter, BoardView } from '../board.js';
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

function card(item: ItemDoc, now: Date, move: string, agents?: Map<string, string>): string {
  const claimed = item.claim !== null && new Date(item.claim.expiresAt) > now;
  const classes = ['card', item.stale ? 'is-stale' : '', claimed ? 'is-claimed' : '']
    .filter(Boolean)
    .join(' ');
  // The title is the one thing a column is too narrow for, so it is clamped to
  // two lines here and shown whole in the preview the card links to.
  return `<article class="${classes}">
  <a class="peek" href="#${escapeHtml(item._id)}">
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
    ${item.stale ? chip('stale', 'stale') : ''}
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
): string {
  const claimed = item.claim !== null && new Date(item.claim.expiresAt) > now;
  return `<div class="peeked" id="${escapeHtml(item._id)}">
  <a class="scrim" href="#" aria-label="Close"></a>
  <div class="sheet">
    <div class="sheet-top">
      <span class="slug">${escapeHtml(item.slug)}</span>
      <a class="close" href="#">close</a>
    </div>
    <h3>${escapeHtml(item.title || '(no title)')}</h3>
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
   * Said above the board when a search was dropped for reading too long.
   *
   * The board below it is the whole board, not the search. Rendering the search
   * as if it had answered nothing would be the page saying there is nothing to
   * find, which is the one thing a stopped search did not establish.
   */
  searchStopped?: string;
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
          shown.length === 0
            ? `<p class="notice">Nothing on this board yet. It fills in when an agent writes its
first item, and the columns below are already waiting for the work.</p>`
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
      <header><h3>${escapeHtml(cell.title)}</h3><span class="n">${cell.count}</span></header>
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
                  options.agents,
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
${shown
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
export function renderNewItem(action: string, requireBodyAfterHours: number | null): string {
  return `<p class="addcard"><a href="#new-item">Add an item</a></p>
<div class="peeked" id="new-item">
  <a class="scrim" href="#" aria-label="Close"></a>
  <div class="sheet">
    <div class="sheet-top">
      <span class="slug">new item</span>
      <a class="close" href="#">close</a>
    </div>
    <h3>Add an item</h3>
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
</div>`;
}

/**
 * The narrowing controls. A GET form, so the result is a URL somebody can keep:
 * an agent's own board is a bookmark, not a session.
 */
/** How much of an agent's own description an option can carry before it wraps. */
const FACET_DESCRIPTION = 44;

function option(value: string, label: string, selected: string | undefined): string {
  return `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

/**
 * Every name this board can be narrowed to, including the one already chosen.
 *
 * A filter that silently forgets the name it is currently applying is worse
 * than no filter: the page says it is showing one agent's work, and pressing
 * Show quietly means everybody. A name can arrive from the URL, or be pushed
 * past the ceiling by a busy project, so the current value is put back in
 * whenever the lists do not already have it.
 */
function agentOptions(agents: AgentFacet[], selected: string | undefined): string {
  const describe = (agent: AgentFacet): string =>
    agent.description === ''
      ? agent.handle
      : `${agent.handle} - ${
          agent.description.length > FACET_DESCRIPTION
            ? `${agent.description.slice(0, FACET_DESCRIPTION - 1).trimEnd()}...`
            : agent.description
        }`;

  const group = (title: string, members: AgentFacet[]): string =>
    members.length === 0
      ? ''
      : `<optgroup label="${escapeHtml(title)}">
        ${members.map((agent) => option(agent.handle, describe(agent), selected)).join('\n        ')}
      </optgroup>`;

  const missing =
    selected && !agents.some((agent) => agent.handle === selected)
      ? option(selected, selected, selected)
      : '';

  return [
    `<option value="">any agent</option>`,
    missing,
    group(
      'Registered here',
      agents.filter((agent) => agent.registered),
    ),
    group(
      'Seen on items',
      agents.filter((agent) => !agent.registered),
    ),
  ]
    .filter((part) => part !== '')
    .join('\n      ');
}

/**
 * The narrowing controls, and the one control that is not a narrowing.
 *
 * The switch reloads the page every minute, for the case this board is for:
 * agents writing while somebody watches. It says what it does rather than what
 * it is for, because the first person to meet it asked what it meant, and a
 * control nobody can read is a control nobody turns on.
 *
 * Off unless asked for, and in the URL like every filter here, so it survives
 * the reload it causes and can be kept as a bookmark. Off by default because a
 * page that reloads under somebody's hands throws away the note they were half
 * way through typing.
 */
export function renderBoardFilters(
  view: BoardView,
  facets: BoardFacets,
  action: string,
  live = false,
): string {
  if (facets.owners.length === 0 && facets.agents.length === 0 && facets.labels.length === 0) {
    return '';
  }
  const owners = [`<option value="">anyone</option>`]
    .concat(
      facets.owners.includes(view.filter.owner ?? '')
        ? []
        : view.filter.owner
          ? [option(view.filter.owner, view.filter.owner, view.filter.owner)]
          : [],
    )
    .concat(facets.owners.map((value) => option(value, value, view.filter.owner)))
    .join('\n      ');

  // Each kind names its own parameter. One combined sentence pointing at
  // `?agent=` sends somebody looking for a missing owner to a query that
  // cannot select one.
  const more = (count: number, kind: string, parameter: string): string =>
    count === 0
      ? ''
      : `<span class="hint">${count} more ${kind}${count === 1 ? '' : 's'} exist; add <code>?${parameter}=</code> to the URL to use one.</span>`;

  return `<form class="row filters" method="get" action="${escapeHtml(action)}">
  <label>Owner
    <select name="owner">
      ${owners}
    </select>
  </label>
  <label>Agent
    <select name="agent">
      ${agentOptions(facets.agents, view.filter.agent)}
    </select>
  </label>
  ${
    facets.labels.length === 0
      ? ''
      : `<label>Label
    <select name="label">
      ${[`<option value="">any label</option>`]
        .concat(
          facets.labels.includes(view.filter.label ?? '') || !view.filter.label
            ? []
            : [option(view.filter.label, view.filter.label, view.filter.label)],
        )
        .concat(facets.labels.map((value) => option(value, value, view.filter.label)))
        .join('\n      ')}
    </select>
  </label>`
  }
  <label>Find
    <input type="search" name="q" value="${escapeHtml(view.filter.q ?? '')}"
      placeholder="slug or title" size="16">
  </label>
  <label class="live" title="The agents write to this board while you are looking at it. On, the page fetches itself again once a minute.">
    <input type="checkbox" name="live" value="1"${live ? ' checked' : ''}>
    Reload every minute</label>
  <button type="submit">Show</button>
  ${
    view.filter.owner || view.filter.agent || view.filter.label || view.filter.q
      ? `<a class="ghost-link" href="${escapeHtml(action)}${live ? '?live=1' : ''}">whole board</a>`
      : ''
  }
  ${more(facets.omitted.owners, 'owner', 'owner')}
  ${more(facets.omitted.agents, 'agent', 'agent')}
  ${more(facets.omitted.labels, 'label', 'label')}
</form>`;
}

export function renderBoardSettings(
  project: ProjectDoc,
  view: BoardView,
  action: string,
  warnings: string[] = [],
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

<h3>Start from one of these</h3>
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

<h3>What a filter can say</h3>
<div class="scroll"><table>
<thead><tr><th>Key</th><th>Meaning</th></tr></thead>
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

<h3>What a move does</h3>
<p>By default, the column's own filter read back at it: the one status it asks for, the first label
it requires, every label it excludes, the one owner it names, a claim where it asks for held items,
a release where it asks for free ones, and a touch where it asks for work that is not stale.
Declaring <code>apply</code> replaces that reading entirely, so spell out everything the move should
do, not only the part the filter got wrong. It also takes the column off the list of views above:
the declaration is the author's word on what belongs here, and where the filter still asks for more
than the move can set, the reply says which column the card actually landed in.</p>
<div class="scroll"><table>
<thead><tr><th>Key</th><th>What moving a card here does</th></tr></thead>
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
