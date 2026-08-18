/**
 * Server-rendered HTML. No client framework, no hydration, no JavaScript at
 * all.
 *
 * That is not minimalism for its own sake: Let Agents In checks 3 and 11 require
 * documentation and the signup form to be present in the first HTML response,
 * and every agent that has to render JavaScript to read a page is an agent that
 * gives up. The human UI being cheap is a side effect of getting that right.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root {
  --bg:#f5f7f5; --surface:#fff; --surface-2:#ecefec; --ink:#141917; --ink-2:#3c4643;
  --muted:#61706c; --rule:#d6dcd8; --accent:#0e5f59; --accent-soft:#dcebe8;
  --danger:#a2372a; --warn:#8a6410; --ok:#2c6b48;
  /* What a modal dims the page with, and what a shadow is made of. Both used to
     be mixed from --ink, which is the text colour: in the dark theme that is
     nearly white, so the layer meant to push the board back lit it up instead.
     A shadow is dark in both themes or it is not a shadow. */
  --scrim:#0b100f;
  /* How dark a handle's colour is. The hue identifies the agent and comes off
     its name; the lightness has to answer to the page it is drawn on, or one
     number ends up trying to be legible on white and on near black at once. */
  --who-l:0.45;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#0e1413; --surface:#151d1b; --surface-2:#1d2725; --ink:#e7ecea; --ink-2:#c3ccc9;
    --muted:#8e9c98; --rule:#2a3634; --accent:#55c4b5; --accent-soft:#17302d;
    --danger:#e37966; --warn:#d3a445; --ok:#63c08a; --scrim:#030807; --who-l:0.82;
  }
}
/* So the scrollbars, the native select menus and the caret follow the page
   rather than staying light under a dark one. */
:root { color-scheme: light dark; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
  font-size:16.5px; line-height:1.6; -webkit-font-smoothing:antialiased; }
.wrap { max-width:900px; margin:0 auto; padding:32px 20px 80px; }
/* A board page widens the column; the prose inside it stays readable. */
.wrap.wide { max-width:1500px; }
/* Prose keeps its measure. The filter bar is not prose: bound to 66 characters
   it wrapped its last field onto a second row and left half the width of the
   board it belongs to empty. */
.wrap.wide > h1, .wrap.wide > p, .wrap.wide > .lead, .wrap.wide > form:not(.filters) { max-width:66ch; }
/* Every page's own paragraphs, not just the ones on the pages that remembered
   to ask: /docs and /operator were running to about 104 characters a line. */
.wrap > p { max-width:66ch; }
.prose { max-width:66ch; }
header.top { display:flex; align-items:baseline; gap:16px; flex-wrap:wrap;
  border-bottom:1px solid var(--rule); padding-bottom:14px; margin-bottom:32px; }
header.top a.brand { font-family:var(--serif); font-size:22px; font-weight:600;
  color:var(--ink); text-decoration:none; letter-spacing:-.01em; }
/* Wrapping, because five links plus the wordmark are wider than a phone: the
   row did not wrap, so the document came out wider than the viewport and every
   page scrolled sideways by the width of the last link. */
header.top nav { display:flex; flex-wrap:wrap; gap:8px 14px; font-family:var(--mono); font-size:12.5px; }
h1 { font-family:var(--serif); font-weight:600; font-size:clamp(30px,5vw,44px);
  line-height:1.08; letter-spacing:-.015em; margin:0 0 14px; text-wrap:balance; }
h2 { font-family:var(--serif); font-weight:600; font-size:clamp(21px,3vw,27px);
  line-height:1.2; margin:38px 0 12px; text-wrap:balance; }
h3 { font-size:15px; font-weight:640; margin:26px 0 8px; }
p { margin:0 0 14px; }
a { color:var(--accent); text-underline-offset:2px; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible,
textarea:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
code { font-family:var(--mono); font-size:.87em; background:var(--surface-2);
  padding:.1em .35em; border-radius:3px; }
pre { font-family:var(--mono); font-size:13px; line-height:1.5; background:var(--surface);
  border:1px solid var(--rule); padding:14px 16px; overflow-x:auto; margin:0 0 16px; }
pre code { background:none; padding:0; font-size:inherit; }
ul, ol { margin:0 0 16px; padding-left:1.3em; }
li { margin-bottom:6px; }
.lead { font-family:var(--serif); font-size:19px; line-height:1.45; color:var(--ink-2); max-width:56ch; }
.card { background:var(--surface); border:1px solid var(--rule); padding:18px 20px; margin-bottom:16px; }
.card.accent { border-left:3px solid var(--accent); }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; margin-bottom:18px; }
/* Four cards in a three wide grid leaves one alone on its own row, which reads
   as a mistake rather than as a fourth thing. */
.grid.pairs { grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
.label { font-family:var(--mono); font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
.scroll { overflow-x:auto; border:1px solid var(--rule); background:var(--surface); margin-bottom:18px; }
table { border-collapse:collapse; width:100%; min-width:560px; font-size:14.5px; }
th, td { text-align:left; padding:10px 13px; border-bottom:1px solid var(--rule); vertical-align:top; }
thead th { font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--muted); font-weight:500; background:var(--surface-2); white-space:nowrap; }
tbody tr:last-child td { border-bottom:none; }
td.mono, .mono { font-family:var(--mono); font-size:13px; }
.chip { font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase;
  padding:2px 7px; border-radius:2px; white-space:nowrap; }
.chip.open { color:var(--accent); background:var(--accent-soft); }
.chip.blocked { color:var(--danger); background:color-mix(in srgb,var(--danger) 13%,transparent); }
.chip.done { color:var(--ok); background:color-mix(in srgb,var(--ok) 14%,transparent); }
.chip.dropped { color:var(--muted); background:var(--surface-2); }
.chip.stale { color:var(--warn); background:color-mix(in srgb,var(--warn) 16%,transparent); }
.chip.claim { color:var(--ink-2); background:var(--surface-2); }
/* A question waiting on whoever is reading. The accent is the page's "this is
   addressed to you" colour and the outline is what separates it from a label,
   which is the only other accent chip a card carries.
   Not the .asked below: that is the question panel inside a sheet, and a chip
   wearing its name came out with panel padding on the face of the card. */
.chip.asks { color:var(--accent); background:var(--accent-soft); border:1px solid var(--accent); }
/* A claim is somebody working now; the last writer is somebody who was. The
   outline says "past tense" without spending another colour on it. */
.chip.note { color:var(--muted); background:transparent; border:1px solid var(--rule); }
/* Whose is this. The hue is derived from the handle, so the same agent is the
   same colour on every board, and no two meanings share a colour: the accent,
   the danger red and the warning amber are all reserved elsewhere. */
.who-chip { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono);
  font-size:11px; padding:2px 7px 2px 3px; border-radius:999px; white-space:nowrap;
  color:oklch(var(--who-l) var(--who-c) var(--who-h));
  background:oklch(var(--who-l) var(--who-c) var(--who-h) / .16); }
.who-chip .face { flex:none; border-radius:50%; }
.timeline .who .who-chip { font-size:11px; }
td .face { vertical-align:-3px; margin-right:4px; }
.filters .who-chip { font-size:11.5px; }
/* Acting on a card: in the sheet, where there is room, never on the 230px face. */
.edit { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:flex-end;
  border-top:1px solid var(--rule); margin-top:14px; padding-top:14px; }
.edit form.row { max-width:none; gap:8px; margin:0; }
.edit label { font-size:12px; }
.edit .tags { gap:6px; }
/* The note takes the whole width under the two short fields: it is the one
   control here that somebody writes a sentence into, and a sentence typed into
   a 14 character box is a sentence nobody types. */
.edit form.note { flex:1 0 100%; display:flex; flex-direction:column; gap:6px; margin:0; max-width:none; }
.edit form.note textarea { min-height:56px; width:100%; }
.edit form.note button { align-self:flex-start; }
/* A question waiting on a person, on the card it is about. Marked out from the
   card's own text: it is the one part of a sheet that is addressed to whoever
   is reading rather than describing the work. */
.asked { border:1px solid var(--accent); border-radius:8px; padding:12px 14px; margin-top:14px;
  background:color-mix(in srgb, var(--accent) 5%, transparent); }
.asked .label { color:var(--accent); margin:0 0 6px; }
.asked textarea { width:100%; min-height:52px; }
.asked form { max-width:none; display:flex; flex-direction:column; gap:8px; margin:8px 0 0; }
/* Rewriting what is already there, folded shut. */
.edit .rewrite { flex:1 0 100%; }
.edit .rewrite summary { font-family:var(--mono); font-size:12px; color:var(--muted); cursor:pointer; }
.edit .rewrite form { max-width:none; display:flex; flex-direction:column; gap:6px; margin:8px 0 0; }
.edit .rewrite input, .edit .rewrite textarea { width:100%; }
.edit .rewrite button { align-self:flex-start; }
/* Filing a card. In a sheet, like everything else that is a form rather than
   something to read: on the page it was a pair of large empty boxes above a
   board, which is the page apologising for itself. */
.addcard { margin:0 0 14px; font-family:var(--mono); font-size:12.5px; }
.newitem { display:flex; flex-direction:column; gap:8px; max-width:none; margin:0; }
.newitem label { font-size:12px; font-family:var(--mono); color:var(--muted); }
.newitem input, .newitem textarea { width:100%; }
.newitem button { align-self:flex-start; }
.edit button.tag { font-family:var(--mono); font-size:11px; padding:3px 8px; border-radius:999px; }
/* A control revealed by hover is a control that does not exist on a phone. */
@media (hover: none) { .col .card .move { opacity:1; } }
/* A line above the headline, saying who this page is for before it says what
   the thing is. Cheap, and it stops the h1 from having to do both jobs. */
.eyebrow { font-family:var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase;
  color:var(--accent); margin:0 0 10px; }
/* The board on the front page is a demonstration, not a control surface: it
   sits in a frame that says "this is a picture of the product", and it never
   grows past the reading column the way a real board is allowed to. */
.demo { border:1px solid var(--rule); border-radius:4px; background:var(--surface);
  padding:14px 14px 4px; margin:0 0 14px; }
/* Sized so all four columns fit the reading column: a demonstration that has to
   be scrolled sideways to be seen whole has demonstrated the wrong thing. */
.demo .cols { grid-auto-columns:minmax(0,1fr); width:auto; gap:10px; }
.demo .lane { width:auto; }
.demo .col { max-height:none; min-width:0; padding:8px; }
.demo .card { cursor:default; }
.demo .card .t { font-size:13px; }
.demo .who-chip { font-size:10.5px; padding:1px 6px 1px 2px; }
@media (max-width:640px) { .demo .cols { grid-auto-flow:row; } }
form { display:flex; flex-direction:column; gap:12px; max-width:440px; }
form.row { flex-direction:row; align-items:flex-end; gap:10px; max-width:none; flex-wrap:wrap; }
label { display:flex; flex-direction:column; gap:5px; font-size:14px; color:var(--ink-2); }
input, select, textarea { font:inherit; font-size:15px; padding:9px 11px; background:var(--surface);
  color:var(--ink); border:1px solid var(--rule); border-radius:3px; }
textarea { min-height:80px; font-family:var(--mono); font-size:13.5px; }
button { font:inherit; font-size:14.5px; font-weight:560; padding:9px 16px; cursor:pointer;
  background:var(--accent); color:var(--bg); border:1px solid var(--accent); border-radius:3px; }
button.ghost { background:transparent; color:var(--accent); }
/* board */
/* Prose wants 66 characters, a board wants room, so a board page widens the
   whole column (see .wrap.wide) rather than escaping it with viewport-width
   tricks: 100vw counts the scrollbar, which pushes the page itself sideways by
   exactly that much. The scrolling belongs to this element, never to the page. */
.board { overflow-x:auto; overscroll-behavior-x:contain; padding-bottom:10px; margin-bottom:10px; }
.lane { margin-bottom:22px; width:max-content; min-width:100%; }
.lane > .lane-title { font-family:var(--mono); font-size:11px; letter-spacing:.09em; text-transform:uppercase;
  color:var(--muted); padding:0 0 8px; border-bottom:1px solid var(--rule); margin-bottom:12px; }
/* stretch, not start: four framed columns holding different amounts of work
   used to end at four different heights, which reads as a rendering fault
   rather than as a difference in how much work each one holds. */
.cols { display:grid; grid-auto-flow:column; grid-auto-columns:270px; gap:12px; align-items:stretch;
  width:max-content; }
/* A column scrolls inside itself. Twenty-five cards in one lane otherwise push
   everything below the board a screen and a half down the page. */
.col { background:var(--surface-2); border:1px solid var(--rule); border-radius:3px; padding:10px;
  display:flex; flex-direction:column; gap:8px; min-width:230px;
  max-height:min(70vh,720px); overflow-y:auto; }
.col > header { position:sticky; top:-10px; background:var(--surface-2); padding:2px 0 4px; z-index:1; }
.col > header { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.col h3 { margin:0; font-size:14px; font-weight:640; }
.col .n { font-family:var(--mono); font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
.col .why { font-family:var(--mono); font-size:10.5px; color:var(--muted); line-height:1.35; margin:-4px 0 0; }
/* Scoped to a column on purpose: an unscoped .card here would win over the page
   card above it and quietly restyle every card on every other page. */
.col .card { background:var(--surface); border:1px solid var(--rule); border-radius:2px;
  padding:9px 10px; margin:0; display:flex; flex-direction:column; gap:5px; }
/* anywhere, not break-all: a slug is read and retyped, and it has natural
   break points at its colon and its hyphens. break-all ignored them and split
   errors:venue-withdraw-stuck as "...withdraw-st" and "uck". */
.col .card .slug { font-family:var(--mono); font-size:11px; color:var(--muted); overflow-wrap:anywhere; }
/* The whole card body is the link to its preview: a title clamped to two lines
   has to be readable somewhere, and the card itself is where people click. */
.col .card .peek { display:flex; flex-direction:column; gap:5px; text-decoration:none;
  color:inherit; border:0; }
.col .card .peek:hover .t { color:var(--accent); }
.col .card .t { font-size:13.5px; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2;
  -webkit-box-orient:vertical; overflow:hidden; }
.col .card .meta { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
/* The bottom line of a card: when it last moved, and how urgent it is. One row
   with the two ends pinned, so a column of cards lines both up. */
.col .card .foot { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.col .card .prio { font-family:var(--mono); font-size:11.5px; font-weight:600;
  font-variant-numeric:tabular-nums; color:var(--ink-2); }
.col .card.is-stale { border-left:2px solid var(--warn); }
.col .card.is-claimed { border-left:2px solid var(--accent); }
/* The move control. A select and a button, because a drag needs JavaScript and
   this page has none. It stays quiet until the card is hovered or the select is
   focused, so a full column still reads as a list of work. */
/* flex-direction and max-width are reset explicitly: the page-wide form rule
   above stacks fields in a 440px column, and inheriting either of those here
   drops the button onto its own line inside a 230px card. */
.col .card .move { display:flex; flex-direction:row; align-items:center; gap:4px;
  max-width:none; opacity:.72; transition:opacity .12s; }
.col .card:hover .move, .col .card .move:focus-within { opacity:1; }
.col .card .move select { flex:1; min-width:0; font-size:11.5px; padding:2px 4px;
  border:1px solid var(--rule); border-radius:2px; background:var(--surface); color:var(--ink); }
.col .card .move button { font-size:11px; padding:3px 7px; border-radius:2px;
  background:transparent; border:1px solid var(--rule); color:var(--ink-2); cursor:pointer; }
.col .card .move button:hover { border-color:var(--accent); color:var(--accent); }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
  clip:rect(0 0 0 0); white-space:nowrap; border:0; }
/* The card preview. :target, not a dialog: the URL opens it, "#" closes it, and
   it works with scripting off like everything else here. It also means a
   preview is a link somebody can send. */
.peeked { display:none; }
/* Two ways in, one look: the fragment, which a browser opens for free, and the
   class, which is what a page rendered for one open card can promise without
   one. */
.peeked:target, .peeked.open { display:block; position:fixed; inset:0; z-index:50; }
.peeked .scrim { position:absolute; inset:0; background:color-mix(in srgb,var(--scrim) 55%,transparent);
  border:0; }
.peeked .sheet { position:relative; margin:6vh auto; max-width:min(680px,92vw); max-height:88vh;
  overflow-y:auto; background:var(--surface); border:1px solid var(--rule); border-radius:4px;
  padding:20px 22px; box-shadow:0 18px 50px color-mix(in srgb,var(--scrim) 30%,transparent);
  display:flex; flex-direction:column; gap:12px; }
.peeked .sheet-top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.peeked .sheet-top .slug { font-family:var(--mono); font-size:12px; color:var(--muted);
  word-break:break-all; }
.peeked .sheet h3 { margin:0; font-size:21px; line-height:1.25; text-wrap:balance; }
.peeked .sheet .meta { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.peeked .sheet .body { margin:0; white-space:pre-wrap; font-size:14.5px; line-height:1.55; }
.peeked .sheet .why { font-family:var(--mono); font-size:11px; color:var(--muted); margin:0; }
.peeked .sheet .none { color:var(--muted); font-style:italic; margin:0; font-size:14px; }
.peeked .sheet .timeline { border-top:1px solid var(--rule); padding-top:4px; }
/* Filters that apply themselves. Every value is a link, so choosing is the
   whole interaction: no button to press afterwards, and choosing what is
   already chosen turns it off. */
.filters { display:flex; flex-direction:column; gap:6px; margin:0 0 16px;
  border:1px solid var(--rule); border-radius:6px; padding:10px 12px; background:var(--surface); }
.filter-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
.filter-key { font-family:var(--mono); font-size:10.5px; letter-spacing:.09em;
  text-transform:uppercase; color:var(--muted); min-width:52px; }
.chip-link { font-family:var(--mono); font-size:12px; padding:2px 8px; border-radius:999px;
  border:1px solid var(--rule); color:var(--ink-2); text-decoration:none; }
.chip-link:hover { border-color:var(--accent); color:var(--accent); }
.chip-link.on { background:var(--accent); border-color:var(--accent); color:var(--surface); }
/* A name nobody registered. Drawn as what it is, a handle read off an item,
   rather than filed under a second heading that costs a row to say the same. */
.chip-link.loose { border-style:dashed; }
/* Chosen and undeclared at once: the dashes have to stay readable, and against
   the accent fill an accent border has no gaps to see. */
.chip-link.loose.on { border-color:var(--surface); }
.filter-more { display:inline; }
.filter-more summary { display:inline; font-family:var(--mono); font-size:12px;
  color:var(--muted); cursor:pointer; }
.filter-row form { display:inline-flex; margin:0; max-width:none; }
.filter-row input[type="search"] { font-size:13px; padding:4px 9px; }
.reset { font-family:var(--mono); font-size:12px; padding:3px 10px; border-radius:4px;
  border:1px solid var(--rule); color:var(--ink-2); text-decoration:none; margin-left:auto; }
.reset:hover { border-color:var(--accent); color:var(--accent); }
.filters label { font-family:var(--mono); font-size:11px; letter-spacing:.09em;
  text-transform:uppercase; color:var(--muted); }
.filters select { font-size:14px; padding:6px 9px; min-width:170px; max-width:230px; }
.filters button { padding:7px 14px; }
.filters .hint { align-self:center; font-size:12.5px; color:var(--muted); }
.ghost-link { align-self:center; font-size:13.5px; }
.col .more { font-family:var(--mono); font-size:11px; color:var(--muted); }
.col .none { font-size:12.5px; color:var(--muted); font-style:italic; }
.timeline { list-style:none; padding:0; margin:0; font-size:14px; }
.timeline li { display:grid; grid-template-columns:auto auto 1fr; gap:10px; padding:7px 0;
  border-top:1px solid var(--rule); align-items:baseline; }
.timeline .when, .timeline .who { font-family:var(--mono); font-size:12px; color:var(--muted); white-space:nowrap; }
.timeline .who.hygiene { color:var(--warn); }
.empty { color:var(--muted); font-style:italic; }
footer.bot { margin-top:56px; border-top:1px solid var(--rule); padding-top:16px;
  font-size:13px; color:var(--muted); display:flex; gap:16px; flex-wrap:wrap; }
.notice { background:var(--accent-soft); border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);
  padding:14px 16px; margin-bottom:18px; font-size:15px; }
.notice.warn { background:color-mix(in srgb,var(--warn) 12%,transparent);
  border-color:color-mix(in srgb,var(--warn) 35%,transparent); }
time { white-space:nowrap; }
/* What the columns hold, in one line, for the width where the board itself is a
   strip that scrolls sideways. */
details.layout { margin-top:34px; border-top:1px solid var(--rule); padding-top:10px; }
details.layout > summary { cursor:pointer; color:var(--muted); font-family:var(--mono);
  font-size:12px; letter-spacing:.08em; text-transform:uppercase; padding:4px 0; }
details.layout > summary:hover { color:var(--accent); }
details.layout[open] > summary { margin-bottom:10px; }
.tally { display:none; font-family:var(--mono); font-size:12.5px; color:var(--muted); }
.tally b { color:var(--ink); font-variant-numeric:tabular-nums; }
@media (max-width:560px) {
  .timeline li { grid-template-columns:1fr; gap:2px; }
  .tally { display:block; }
  /* A table narrower than the phone is a table with a column off the screen,
     and the column that goes first is the last one: the links. Nothing on the
     page said it scrolled sideways, so on the operator's own list of projects
     the only way into any of them was invisible. Below 560 each row becomes a
     small card and every cell carries its own heading.

     Only the tables that asked for it, by carrying the cards class and a
     data-label on every cell. A reference table turned into unlabelled cards
     is worse than one that scrolls: the pricing table rendered for a while as
     "50", "5", "20" with nothing to say which number was which. Everything
     else keeps its own horizontal scrolling, because a wide child with
     nowhere to go pushes the whole page sideways instead. */
  .scroll.cards { overflow-x:visible; border:0; background:none; }
  table.cards { min-width:0; display:block; }
  table.cards thead { display:none; }
  table.cards tbody, table.cards tr, table.cards td { display:block; }
  table.cards tbody tr { background:var(--surface); border:1px solid var(--rule);
    border-radius:3px; padding:8px 11px; margin-bottom:10px; }
  table.cards td { border-bottom:0; padding:3px 0; }
  table.cards tbody tr:last-child { margin-bottom:0; }
  table.cards td[data-label]::before { content:attr(data-label); display:block;
    font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase;
    color:var(--muted); }
}
`;

/**
 * A search console's ownership token, set once at boot.
 *
 * It lives here rather than travelling through every layout call because it is
 * a property of the deployment and not of any page: threading a constant
 * through forty call sites is how a constant becomes a parameter nobody passes.
 */
let siteVerification = '';

export function setSiteVerification(token: string): void {
  siteVerification = token;
}

export interface LayoutOptions {
  title: string;
  description?: string;
  nav?: boolean;
  /** Widens the column for a board, which needs room rather than 66 characters. */
  wide?: boolean;
  /**
   * Whether this page is being rendered for somebody already signed in. Only
   * the nav label depends on it, and only pages that already hold a session
   * pass it, so no page does a database read to decide what to call a link.
   */
  signedIn?: boolean;
  /**
   * A search console's ownership token, when the deployment has one. It is a
   * meta tag rather than a DNS record because a self-host controls its own
   * pages and may not control the zone.
   */
  verification?: string;
  /**
   * Reload the page every N seconds, for a board somebody is watching while
   * agents write to it.
   *
   * A meta tag because there is no JavaScript here and there is not going to
   * be. Never on by default: a page that reloads under somebody's hands throws
   * away the sentence they were typing, and losing your own words is worse than
   * a board that is a minute behind.
   */
  refreshSeconds?: number;
}

export function layout(options: LayoutOptions, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${options.refreshSeconds ? `<meta http-equiv="refresh" content="${Math.round(options.refreshSeconds)}">
` : ''}
${options.description ? `<meta name="description" content="${escapeHtml(options.description)}">` : ''}
${(options.verification ?? siteVerification) ? `<meta name="google-site-verification" content="${escapeHtml(options.verification ?? siteVerification)}">\n` : ''}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0e5f59">
<style>${CSS}</style>
</head>
<body>
<div class="wrap${options.wide ? ' wide' : ''}">
${
    options.nav === false
      ? ''
      : `<header class="top">
  <a class="brand" href="/">Muster</a>
  <nav>
    <a href="/docs">docs</a>
    <a href="/skill.md">skill.md</a>
    <a href="/pricing">pricing</a>
    <a href="/operator">${options.signedIn ? 'your projects' : 'sign in'}</a>
    <a href="/signup">start</a>
  </nav>
</header>`
  }
${body}
<footer class="bot">
  <span>Muster</span>
  <a href="https://github.com/krystiangw/muster">source on GitHub</a>
  <a href="/llms.txt">llms.txt</a>
  <a href="/openapi.json">openapi.json</a>
  <a href="/.well-known/agent-access.json">agent-access.json</a>
  <a href="/agent-signup.md">agent-signup.md</a>
</footer>
</div>
</body>
</html>`;
}

export function chip(text: string, kind: string): string {
  return `<span class="chip ${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

export function formatWhen(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago, in words, with the exact instant kept underneath.
 *
 * Every timestamp on these pages used to be printed as bare UTC, unlabelled.
 * At two minutes to midnight in Warsaw, a card written ten minutes ago read
 * `2026-08-17 21:48`, and a live claim read `lease until 2026-08-17 22:48`,
 * which is an hour in the past to anybody reading a clock. The page was
 * quietly wrong about the one thing an operator opens it to learn.
 *
 * A relative age needs no timezone and answers the question that was actually
 * asked: is anybody still on this. The instant is still there, in the tooltip
 * and in `datetime`, for whoever needs to correlate it with a log.
 */
export function ago(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';

  const delta = d.getTime() - now.getTime();
  const size = Math.abs(delta);
  // Everything below reads as "N ago" or "in N", and the two sides share the
  // same thresholds so that a lease about to expire and one that just did are
  // described at the same resolution.
  const say = (text: string): string => (delta >= 0 ? `in ${text}` : `${text} ago`);

  if (size < 45 * 1000) return delta >= 0 ? 'in a moment' : 'just now';
  if (size < 60 * MINUTE) return say(`${Math.round(size / MINUTE)} min`);
  if (size < 36 * HOUR) return say(`${Math.round(size / HOUR)} h`);
  if (size < 14 * DAY) return say(`${Math.round(size / DAY)} d`);
  // Past a fortnight the age stops being the useful part: nobody acts on "31 d
  // ago", and a date is what somebody would search a log for.
  return d.toISOString().slice(0, 10);
}

/** The same, as an element a browser can show the exact instant for. */
export function when(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return `<time datetime="${d.toISOString()}" title="${escapeHtml(formatWhen(d))}">${escapeHtml(
    ago(d, now),
  )}</time>`;
}
