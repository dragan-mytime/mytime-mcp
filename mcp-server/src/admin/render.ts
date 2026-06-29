/** Shared HTML helpers for the admin panel — styled to the MY:TIME brand. */

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escape any value — converts to string first. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);
}

/** Hidden CSRF field. */
export function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
}

/** The MY:TIME wordmark (from mytime.mk), recolorable via `color` (fill=currentColor). */
const LOGO = `<svg class="logo" viewBox="0 0 342.16 51.08" fill="currentColor" role="img" aria-label="MY:TIME"><path d="M51,51H41V17.59L27.51,31.92H23.67L9.91,17.57V51H0V0H5.86L25.55,20.54,45.09,0H51Z"/><path d="M86.55,51H77.43V30.84L58.55.36h11.8L81.92,19.89,93.56.36h11l-18,30.76Z"/><polygon points="293.2 51.02 283.29 51.02 283.29 17.59 269.75 31.92 265.92 31.92 252.16 17.57 252.16 51.02 242.25 51.02 242.25 0 248.1 0 267.8 20.54 287.35 0 293.2 0 293.2 51.02"/><polygon points="342.16 51.02 305.73 51.02 305.73 0.36 342.16 0.36 342.16 8.82 315.64 8.82 315.64 20.05 339.32 20.05 339.32 28.8 315.64 28.8 315.64 42.35 342.16 42.35 342.16 51.02"/><path d="M178.28,51H167.57V9.55H151.35V.21H194.5V9.55H178.28Z"/><path d="M223.45,51.08H213.24V.24h10.21Z"/><path d="M126.47,40.88a5.27,5.27,0,0,1-4-1.47,5.45,5.45,0,0,1-1.4-3.95,5.69,5.69,0,0,1,1.53-4.09,5.56,5.56,0,0,1,4.15-1.58,5.11,5.11,0,0,1,3.81,1.45h0A5.38,5.38,0,0,1,132,35.13a5.78,5.78,0,0,1-1.48,4.15A5.38,5.38,0,0,1,126.47,40.88Z"/><path d="M126.47,24.11a5.23,5.23,0,0,1-3.94-1.46,5.43,5.43,0,0,1-1.41-4,5.67,5.67,0,0,1,1.53-4.08A5.57,5.57,0,0,1,126.8,13a5.1,5.1,0,0,1,3.82,1.46h0A5.38,5.38,0,0,1,132,18.37a5.79,5.79,0,0,1-1.48,4.15A5.37,5.37,0,0,1,126.47,24.11Z"/></svg>`;

const NAV_ITEMS: { href: string; label: string }[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/recipients", label: "Recipients" },
  { href: "/admin/digests", label: "Digests" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/targets", label: "Targets" },
];

/** Wrap body in a full HTML document with the branded header + optional flash. */
export function layout(
  title: string,
  body: string,
  opts?: { flash?: string; activeNav?: string },
): string {
  const flash = opts?.flash ? `<div class="flash">${esc(opts.flash)}</div>` : "";
  const active = opts?.activeNav ?? title;
  const links = NAV_ITEMS.map(
    (n) =>
      `<a href="${n.href}"${n.label === active ? ' class="active" aria-current="page"' : ""}>${n.label}</a>`,
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — MY:TIME Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;500;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #231f20; --slate: #4a4b5c; --muted: #8a8c99;
      --accent: #295280; --accent-2: #3973b5;
      --bg: #ffffff; --surface: #f6f7f9; --border: #e4e6eb;
      --danger: #c0392b; --danger-2: #a5311f;
      --ok-bg: #e8f3ec; --ok-bd: #bcdcc8; --ok-fg: #1e5a39;
      --err-bg: #fbeceb; --err-bd: #f0c8c4; --err-fg: #8a2a1d;
      --radius: 10px; --shadow: 0 1px 2px rgba(35,31,32,.06), 0 6px 20px rgba(35,31,32,.05);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Roboto', system-ui, sans-serif; margin: 0; background: var(--surface); color: var(--slate); -webkit-font-smoothing: antialiased; }
    a { color: var(--accent); }

    /* ── Header ── */
    .hd { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 1rem;
      background: var(--bg); border-bottom: 1px solid var(--border); padding: 0 clamp(1rem, 4vw, 2rem); height: 64px; }
    .hd::after { content: ""; position: absolute; left: 0; right: 0; bottom: -3px; height: 3px;
      background: linear-gradient(90deg, var(--accent), var(--accent-2)); opacity: .9; }
    .brand { display: flex; align-items: center; gap: .7rem; margin-right: auto; text-decoration: none; color: var(--ink); }
    .logo { height: 22px; width: auto; display: block; }
    .badge { font-family: 'Roboto Condensed', sans-serif; font-weight: 700; font-size: .62rem; letter-spacing: .14em;
      text-transform: uppercase; color: var(--accent); border: 1px solid var(--border); border-radius: 999px; padding: .18rem .5rem; }
    .nav { display: flex; align-items: center; gap: .35rem; }
    .nav a { font-family: 'Roboto Condensed', sans-serif; font-weight: 500; font-size: .82rem; letter-spacing: .04em;
      text-transform: uppercase; color: var(--slate); text-decoration: none; padding: .5rem .7rem; border-radius: 7px; transition: all .15s; }
    .nav a:hover { color: var(--ink); background: var(--surface); }
    .nav a.active { color: var(--accent); background: rgba(41,82,128,.08); }
    .nav a.logout { color: var(--muted); }
    .nav a.logout:hover { color: var(--danger); }

    /* ── CSS-only hamburger ── */
    #nav-toggle { display: none; }
    .burger { display: none; flex-direction: column; gap: 5px; width: 42px; height: 42px; justify-content: center;
      align-items: center; cursor: pointer; border-radius: 8px; }
    .burger span { width: 22px; height: 2px; background: var(--ink); border-radius: 2px; transition: transform .25s, opacity .2s; }

    @media (max-width: 820px) {
      .burger { display: flex; }
      .nav { position: absolute; top: 64px; left: 0; right: 0; flex-direction: column; align-items: stretch; gap: 0;
        background: var(--bg); border-bottom: 1px solid var(--border); box-shadow: var(--shadow);
        max-height: 0; overflow: hidden; transition: max-height .28s ease; }
      .nav a { padding: .95rem clamp(1rem,4vw,2rem); border-top: 1px solid var(--border); border-radius: 0; }
      #nav-toggle:checked ~ .nav { max-height: 70vh; }
      #nav-toggle:checked ~ .burger span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
      #nav-toggle:checked ~ .burger span:nth-child(2) { opacity: 0; }
      #nav-toggle:checked ~ .burger span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
    }

    /* ── Content ── */
    main { padding: clamp(1.25rem, 4vw, 2.25rem); max-width: 1080px; margin: 0 auto; }
    h1 { font-family: 'Roboto Condensed', sans-serif; font-weight: 700; color: var(--ink); margin: 0 0 1.25rem;
      font-size: clamp(1.5rem, 4vw, 1.9rem); letter-spacing: -.01em; }
    h2 { font-family: 'Roboto Condensed', sans-serif; font-weight: 700; color: var(--ink); font-size: 1.1rem; margin: 1.5rem 0 .75rem; }

    .flash, .error { padding: .75rem 1rem; margin: 0 0 1.25rem; border-radius: var(--radius); border: 1px solid; font-size: .9rem; }
    .flash { background: var(--ok-bg); border-color: var(--ok-bd); color: var(--ok-fg); }
    .flash.err, .error { background: var(--err-bg); border-color: var(--err-bd); color: var(--err-fg); }

    table { border-collapse: separate; border-spacing: 0; width: 100%; background: var(--bg); border: 1px solid var(--border);
      border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
    th, td { padding: .7rem .95rem; text-align: left; font-size: .875rem; border-bottom: 1px solid var(--border); }
    th { background: var(--surface); font-family: 'Roboto Condensed', sans-serif; font-weight: 700; color: var(--ink);
      text-transform: uppercase; letter-spacing: .05em; font-size: .72rem; }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #fafbfc; }

    .card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem 1.6rem;
      box-shadow: var(--shadow); margin-bottom: 1.5rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.2rem 1.4rem; box-shadow: var(--shadow); }
    .stat .n { font-family: 'Roboto Condensed', sans-serif; font-weight: 700; font-size: 2rem; color: var(--ink); line-height: 1; }
    .stat .l { font-size: .8rem; color: var(--muted); margin-top: .35rem; text-transform: uppercase; letter-spacing: .05em; }

    form { display: contents; }
    label { display: block; font-size: .8rem; margin-bottom: .3rem; font-weight: 500; color: var(--ink); }
    input[type=text], input[type=email], input[type=url], input[type=number], select, textarea {
      width: 100%; padding: .55rem .7rem; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: .875rem;
      margin-bottom: .8rem; background: var(--bg); color: var(--ink); transition: border-color .15s, box-shadow .15s; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(41,82,128,.14); }
    textarea { resize: vertical; min-height: 7rem; }
    input[type=checkbox] { width: auto; margin: 0 .4rem 0 0; accent-color: var(--accent); vertical-align: middle; }
    .inline-form { display: inline; }
    .row-form td { vertical-align: middle; }

    .btn { display: inline-block; padding: .5rem .95rem; border: 1px solid transparent; border-radius: 8px; cursor: pointer;
      font-family: 'Roboto Condensed', sans-serif; font-weight: 600; font-size: .82rem; letter-spacing: .03em;
      text-transform: uppercase; text-decoration: none; transition: all .15s; }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-2); }
    .btn-danger { background: var(--bg); color: var(--danger); border-color: var(--err-bd); }
    .btn-danger:hover { background: var(--danger); color: #fff; border-color: var(--danger); }
    .btn-sm { padding: .3rem .6rem; font-size: .72rem; }
    .note { font-size: .8rem; color: var(--muted); margin-top: .35rem; }
    .muted { color: var(--muted); }

    /* ── Status pill + compact target list ── */
    .pill { display: inline-block; font-family: 'Roboto Condensed', sans-serif; font-weight: 700; font-size: .68rem;
      letter-spacing: .05em; text-transform: uppercase; padding: .2rem .55rem; border-radius: 999px; border: 1px solid; }
    .pill-on { background: var(--ok-bg); color: var(--ok-fg); border-color: var(--ok-bd); }
    .pill-off { background: var(--surface); color: var(--muted); border-color: var(--border); }
    .t-name { font-weight: 500; color: var(--ink); }
    .t-sub { font-size: .72rem; color: var(--muted); margin-top: .1rem; }
    .tbl-compact td:last-child, .tbl-compact th:last-child { text-align: right; white-space: nowrap; }
    .tbl-compact td:nth-child(2), .tbl-compact th:nth-child(2) { white-space: nowrap; }
    @media (max-width: 560px) {
      .tbl-compact th, .tbl-compact td { padding: .6rem .65rem; }
    }
    textarea.mono { font-family: 'Roboto Mono', ui-monospace, monospace; min-height: 14rem; line-height: 1.5; }
    .preview-frame { width: 100%; height: 600px; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; }
  </style>
</head>
<body>
  <header class="hd">
    <a class="brand" href="/admin">${LOGO}<span class="badge">Admin</span></a>
    <input type="checkbox" id="nav-toggle">
    <label class="burger" for="nav-toggle" aria-label="Toggle menu"><span></span><span></span><span></span></label>
    <nav class="nav">
      ${links}
      <a class="logout" href="/admin/auth/logout">Logout</a>
    </nav>
  </header>
  <main>
    ${flash}
    <h1>${esc(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}
