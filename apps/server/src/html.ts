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
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --serif:"Iowan Old Style","Charter","Palatino Linotype",Palatino,Georgia,serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#0e1413; --surface:#151d1b; --surface-2:#1d2725; --ink:#e7ecea; --ink-2:#c3ccc9;
    --muted:#8e9c98; --rule:#2a3634; --accent:#55c4b5; --accent-soft:#17302d;
    --danger:#e37966; --warn:#d3a445; --ok:#63c08a;
  }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
  font-size:16.5px; line-height:1.6; -webkit-font-smoothing:antialiased; }
.wrap { max-width:900px; margin:0 auto; padding:32px 20px 80px; }
/* A board page widens the column; the prose inside it stays readable. */
.wrap.wide { max-width:1500px; }
.wrap.wide > h1, .wrap.wide > p, .wrap.wide > .lead, .wrap.wide > form { max-width:66ch; }
.prose { max-width:66ch; }
header.top { display:flex; align-items:baseline; gap:16px; flex-wrap:wrap;
  border-bottom:1px solid var(--rule); padding-bottom:14px; margin-bottom:32px; }
header.top a.brand { font-family:var(--serif); font-size:22px; font-weight:600;
  color:var(--ink); text-decoration:none; letter-spacing:-.01em; }
header.top nav { display:flex; gap:14px; font-family:var(--mono); font-size:12.5px; }
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
/* A claim is somebody working now; the last writer is somebody who was. The
   outline says "past tense" without spending another colour on it. */
.chip.note { color:var(--muted); background:transparent; border:1px solid var(--rule); }
/* Whose is this. The hue is derived from the handle, so the same agent is the
   same colour on every board, and no two meanings share a colour: the accent,
   the danger red and the warning amber are all reserved elsewhere. */
.who-chip { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono);
  font-size:11px; padding:2px 7px 2px 3px; border-radius:999px; white-space:nowrap;
  color:var(--who); background:var(--who-wash); }
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
  padding:14px 14px 4px; margin:0 0 14px; overflow:hidden; }
.demo .cols { grid-auto-columns:236px; }
.demo .col { max-height:none; }
.demo .card { cursor:default; }
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
.cols { display:grid; grid-auto-flow:column; grid-auto-columns:270px; gap:12px; align-items:start;
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
.col .card .slug { font-family:var(--mono); font-size:11px; color:var(--muted); word-break:break-all; }
/* The whole card body is the link to its preview: a title clamped to two lines
   has to be readable somewhere, and the card itself is where people click. */
.col .card .peek { display:flex; flex-direction:column; gap:5px; text-decoration:none;
  color:inherit; border:0; }
.col .card .peek:hover .t { color:var(--accent); }
.col .card .t { font-size:13.5px; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2;
  -webkit-box-orient:vertical; overflow:hidden; }
.col .card .meta { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
.col .card.is-stale { border-left:2px solid var(--warn); }
.col .card.is-claimed { border-left:2px solid var(--accent); }
/* The move control. A select and a button, because a drag needs JavaScript and
   this page has none. It stays quiet until the card is hovered or the select is
   focused, so a full column still reads as a list of work. */
/* flex-direction and max-width are reset explicitly: the page-wide form rule
   above stacks fields in a 440px column, and inheriting either of those here
   drops the button onto its own line inside a 230px card. */
.col .card .move { display:flex; flex-direction:row; align-items:center; gap:4px;
  max-width:none; opacity:.35; transition:opacity .12s; }
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
.peeked:target { display:block; position:fixed; inset:0; z-index:50; }
.peeked .scrim { position:absolute; inset:0; background:color-mix(in srgb,var(--ink) 45%,transparent);
  border:0; }
.peeked .sheet { position:relative; margin:6vh auto; max-width:min(680px,92vw); max-height:88vh;
  overflow-y:auto; background:var(--surface); border:1px solid var(--rule); border-radius:4px;
  padding:20px 22px; box-shadow:0 18px 50px color-mix(in srgb,var(--ink) 22%,transparent);
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
.filters { align-items:flex-end; margin-bottom:16px; }
.filters label { font-family:var(--mono); font-size:11px; letter-spacing:.09em;
  text-transform:uppercase; color:var(--muted); }
.filters select { font-size:14px; padding:6px 9px; min-width:150px; max-width:320px; }
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
@media (max-width:560px) { .timeline li { grid-template-columns:1fr; gap:2px; } }
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
}

export function layout(options: LayoutOptions, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
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
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
