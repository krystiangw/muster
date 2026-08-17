import type { BoardFilter, BoardView } from '../board.js';
import { BOARD_PRESETS, COLUMN_RENDER_LIMIT, applyForColumn } from '../board.js';
import { boardConfigJson } from '../serialize.js';
import { chip, escapeHtml, formatWhen } from '../html.js';
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
      keep.owner ? `<input type="hidden" name="owner" value="${escapeHtml(keep.owner)}">` : ''
    }${
      keep.agent ? `<input type="hidden" name="agent" value="${escapeHtml(keep.agent)}">` : ''
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
  // which nobody should have to look up in another view.
  const named = (handle: string, text: string, kind: string): string => {
    const about = agents?.get(handle);
    return about
      ? `<span title="${escapeHtml(about)}">${chip(text, kind)}</span>`
      : chip(text, kind);
  };
  if (claimed) parts.push(named(item.claim!.agent, item.claim!.agent, 'claim'));
  else if (item.lastActor) parts.push(named(item.lastActor, `last: ${item.lastActor}`, 'note'));
  if (item.owner) parts.push(chip(`owner: ${item.owner}`, 'dropped'));
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
    ${item.stale ? chip('stale', 'stale') : ''}
    ${(item.labels ?? []).slice(0, 3).map((label) => chip(label, 'open')).join(' ')}
    <span class="slug">${escapeHtml(formatWhen(item.updatedAt))}</span>
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
  agents?: Map<string, string>,
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
      ${item.priority ? chip(`priority ${item.priority}`, 'open') : ''}
      ${(item.labels ?? []).map((label) => chip(label, 'open')).join(' ')}
    </div>
    ${item.body ? `<p class="body">${escapeHtml(item.body)}</p>` : '<p class="none">No description. Whoever picks this up should write one.</p>'}
    ${
      claimed
        ? `<p class="why">Held by ${escapeHtml(item.claim!.agent)}, lease until ${escapeHtml(
            formatWhen(item.claim!.expiresAt),
          )}.</p>`
        : ''
    }
    ${
      timeline.length > 0
        ? `<ul class="timeline">
${timeline
  .map(
    (entry) => `      <li><span class="when">${escapeHtml(formatWhen(entry.at))}</span>
        <span class="who${entry.by === 'hygiene' ? ' hygiene' : ''}">${escapeHtml(entry.by)}</span>
        <span>${escapeHtml(entry.message)}</span></li>`,
  )
  .join('\n')}
    </ul>`
        : ''
    }
    <p class="why">updated ${escapeHtml(formatWhen(item.updatedAt))} &middot; created ${escapeHtml(
      formatWhen(item.createdAt),
    )} &middot; ${item.timelineCount} timeline entr${item.timelineCount === 1 ? 'y' : 'ies'}</p>
  </div>
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
    view.filter.owner || view.filter.agent
      ? `<p class="notice"><b>Narrowed to ${escapeHtml(
          [
            view.filter.owner ? `owner ${view.filter.owner}` : '',
            view.filter.agent ? `agent ${view.filter.agent}` : '',
          ]
            .filter(Boolean)
            .join(' and '),
        )}.</b> The counts below are of that work, not of the whole board.</p>`
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
  .map((item) => preview(item, now, options.timelines?.get(item._id) ?? [], options.agents))
  .join('\n')}`;
}

/**
 * The narrowing controls. A GET form, so the result is a URL somebody can keep:
 * an agent's own board is a bookmark, not a session.
 */
export function renderBoardFilters(
  view: BoardView,
  facets: { owners: string[]; agents: string[] },
  action: string,
): string {
  if (facets.owners.length === 0 && facets.agents.length === 0) return '';
  const options = (values: string[], selected: string | undefined, anything: string): string =>
    [`<option value="">${escapeHtml(anything)}</option>`]
      .concat(
        values.map(
          (value) =>
            `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(value)}</option>`,
        ),
      )
      .join('\n      ');

  return `<form class="row filters" method="get" action="${escapeHtml(action)}">
  <label>Owner
    <select name="owner">
      ${options(facets.owners, view.filter.owner, 'anyone')}
    </select>
  </label>
  <label>Agent
    <select name="agent">
      ${options(facets.agents, view.filter.agent, 'any agent')}
    </select>
  </label>
  <button type="submit">Show</button>
  ${
    view.filter.owner || view.filter.agent
      ? `<a class="ghost-link" href="${escapeHtml(action)}">whole board</a>`
      : ''
  }
</form>`;
}

export function renderBoardSettings(project: ProjectDoc, view: BoardView, action: string): string {
  const current = JSON.stringify(boardConfigJson(view.config), null, 2);
  return `<h2>Layout</h2>
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
<tr><td class="mono">priority_min</td><td>Priority at or above this number.</td></tr>
<tr><td class="mono">fields</td><td>Values kept from another system, e.g. <code>{"legacy_status":["investigating","fix_planned"]}</code>.</td></tr>
</tbody></table></div>
<p>An item lands in the <b>first</b> column that matches, so order the columns the way you read them.
Anything that matches nothing is reported above the board rather than hidden.</p>
<p class="mono" style="color:var(--muted)">Same thing over the API:
PUT ${escapeHtml(project._id ? `/v1/${project._id}/board` : '/v1/{project}/board')}</p>`;
}
