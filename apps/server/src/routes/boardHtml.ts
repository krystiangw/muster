import type { BoardView } from '../board.js';
import { BOARD_PRESETS, COLUMN_RENDER_LIMIT, applyForColumn } from '../board.js';
import { boardConfigJson } from '../serialize.js';
import { chip, escapeHtml, formatWhen } from '../html.js';
import type { ItemDoc, ProjectDoc } from '../types.js';

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
function moveForm(item: ItemDoc, from: string, targets: MoveTarget[], action: string): string {
  const options = targets.filter((target) => target.key !== from);
  if (options.length === 0) return '';
  return `<form class="move" method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="slug" value="${escapeHtml(item.slug)}">
    <label class="sr-only" for="mv-${escapeHtml(from)}-${escapeHtml(item.slug)}">Move ${escapeHtml(item.slug)} to</label>
    <select id="mv-${escapeHtml(from)}-${escapeHtml(item.slug)}" name="column">
${options
  .map((target) => `      <option value="${escapeHtml(target.key)}">${escapeHtml(target.title)}</option>`)
  .join('\n')}
    </select>
    <button type="submit" title="Move this item">move</button>
  </form>`;
}

function card(item: ItemDoc, now: Date, move: string): string {
  const claimed = item.claim !== null && new Date(item.claim.expiresAt) > now;
  const classes = ['card', item.stale ? 'is-stale' : '', claimed ? 'is-claimed' : '']
    .filter(Boolean)
    .join(' ');
  return `<article class="${classes}">
  <div class="slug">${escapeHtml(item.slug)}</div>
  <div class="t">${escapeHtml(item.title || '(no title)')}</div>
  <div class="meta">
    ${claimed ? chip(item.claim!.agent, 'claim') : ''}
    ${item.stale ? chip('stale', 'stale') : ''}
    ${item.owner ? chip(item.owner, 'dropped') : ''}
    ${(item.labels ?? []).slice(0, 3).map((label) => chip(label, 'open')).join(' ')}
    <span class="slug">${escapeHtml(formatWhen(item.updatedAt))}</span>
  </div>
  ${move}
</article>`;
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
}

export function renderBoard(view: BoardView, options: BoardRenderOptions = {}): string {
  const now = options.now ?? new Date();
  const targets: MoveTarget[] = options.moveAction
    ? view.config.columns
        .filter((column) => Object.keys(applyForColumn(column)).length > 0)
        .map((column) => ({ key: column.key, title: column.title }))
    : [];
  const lanes = view.rows.length > 0 ? view.rows : [{ key: '', title: '', columns: [] }];
  // Above the board, not below it: a column is taller than a screen, and a
  // confirmation nobody scrolls to is not a confirmation.
  return `${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ''}
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
                  options.moveAction ? moveForm(item, cell.key, targets, options.moveAction) : '',
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
  }`;
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
