/** Shared HTML helpers for the admin panel. */

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

/** Wrap body in a full HTML document with nav + optional flash banner. */
export function layout(title: string, body: string, opts?: { flash?: string }): string {
  const flash = opts?.flash ? `<div class="flash">${esc(opts.flash)}</div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — MY:TIME Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
    nav { background: #1a1a2e; color: #fff; padding: .75rem 1.5rem; display: flex; gap: 1.5rem; align-items: center; }
    nav a { color: #ccc; text-decoration: none; font-size: .9rem; }
    nav a:hover { color: #fff; }
    nav .brand { font-weight: 700; color: #fff; margin-right: auto; }
    .flash { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: .6rem 1rem; margin: 1rem 1.5rem 0; border-radius: 4px; }
    .flash.err { background: #f8d7da; border-color: #f5c6cb; color: #721c24; }
    main { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    th, td { padding: .55rem .9rem; text-align: left; font-size: .875rem; border-bottom: 1px solid #eee; }
    th { background: #f0f0f0; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    form { display: contents; }
    .card { background: #fff; border-radius: 6px; padding: 1.25rem 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 1.5rem; }
    label { display: block; font-size: .875rem; margin-bottom: .25rem; font-weight: 500; }
    input[type=text], input[type=email], input[type=url], input[type=number], select, textarea {
      width: 100%; padding: .4rem .6rem; border: 1px solid #ccc; border-radius: 4px; font-size: .875rem; margin-bottom: .75rem;
    }
    textarea { resize: vertical; }
    .inline-form { display: inline; }
    .btn { display: inline-block; padding: .4rem .85rem; border: none; border-radius: 4px; cursor: pointer; font-size: .875rem; }
    .btn-primary { background: #0066cc; color: #fff; }
    .btn-primary:hover { background: #0052a3; }
    .btn-danger { background: #dc3545; color: #fff; }
    .btn-danger:hover { background: #b02a37; }
    .btn-sm { padding: .25rem .55rem; font-size: .8rem; }
    .note { font-size: .8rem; color: #666; margin-top: .25rem; }
    .row-form td { vertical-align: middle; }
    input[type=checkbox] { width: auto; margin: 0 .25rem 0 0; }
  </style>
</head>
<body>
  <nav>
    <span class="brand">MY:TIME Admin</span>
    <a href="/admin">Dashboard</a>
    <a href="/admin/users">Users</a>
    <a href="/admin/recipients">Recipients</a>
    <a href="/admin/settings">Settings</a>
    <a href="/admin/targets">Targets</a>
    <a href="/admin/auth/logout">Logout</a>
  </nav>
  ${flash}
  <main>
    <h1>${esc(title)}</h1>
    ${body}
  </main>
</body>
</html>`;
}
