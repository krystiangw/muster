import type { AgentFacet, BoardFacets, BoardFilter, BoardView } from '../board.js';
import { BOARD_PRESETS, COLUMN_RENDER_LIMIT, applyForColumn } from '../board.js';
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
 */
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
        .filter((column) => Object.keys(applyForColumn(column)).length > 0)
        .map((column) => ({ key: column.key, title: column.title }))
    : [];
  const lanes = view.rows.length > 0 ? view.rows : [{ key: '', title: '', columns: [] }];
  const shown = lanes.flatMap((lane) =>
    lane.columns.flatMap((cell) => cell.items.slice(0, COLUMN_RENDER_LIMIT)),
  );
  // Above the board, not below it: a column is taller than a screen, and a
  // confirmation nobody scrolls to is not a confirmation.
  return `${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ''}
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
    ),
  )
  .join('\n')}`;
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

export function renderBoardFilters(view: BoardView, facets: BoardFacets, action: string): string {
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
  <button type="submit">Show</button>
  ${
    view.filter.owner || view.filter.agent || view.filter.label || view.filter.q
      ? `<a class="ghost-link" href="${escapeHtml(action)}">whole board</a>`
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
<tr><td class="mono">fields</td><td>Values kept from another system, e.g. <code>{"legacy_status":["investigating","fix_planned"]}</code>.</td></tr>
</tbody></table></div>
<p>An item lands in the <b>first</b> column that matches, so order the columns the way you read them.
Anything that matches nothing is reported above the board rather than hidden.</p>
<p class="mono" style="color:var(--muted)">Same thing over the API:
PUT ${escapeHtml(project._id ? `/v1/${project._id}/board` : '/v1/{project}/board')}</p>
</details>`;
}
