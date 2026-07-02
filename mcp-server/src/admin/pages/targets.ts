import type { Request } from "express";
import { adminWritePool } from "../../writePool.js";
import { csrfField, esc } from "../render.js";
import { checkCsrf } from "../session.js";

interface AdminReq extends Request {
  admin: { email: string; csrf: string };
  body: Record<string, unknown>;
}

interface TargetRow {
  id: string;
  name: string;
  web_url: string | null;
  social: Record<string, string> | null;
  active: boolean;
  platform: string | null;
}

// Accept http(s) URLs or empty string
const URL_RE = /^https?:\/\/.+/i;

/** D7: validate that a URL's hostname is within an expected domain (or its www./m. subdomains). */
function validatePlatformUrl(
  rawUrl: string,
  platform: string,
  allowedDomain: string,
): string | null {
  if (!rawUrl) return null; // empty is fine
  if (!URL_RE.test(rawUrl)) return `${platform} URL must start with https://`;
  try {
    const { protocol, hostname } = new URL(rawUrl);
    if (protocol !== "https:") return `${platform} URL must use https://`;
    const host = hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    if (host !== allowedDomain) return `${platform} URL must be on ${allowedDomain}`;
  } catch {
    return `${platform} URL is invalid`;
  }
  return null; // valid
}

function socialHandle(social: Record<string, string> | null, key: string): string {
  if (!social || typeof social !== "object") return "";
  const val = (social as Record<string, unknown>)[key];
  return typeof val === "string" ? val : "";
}

/** Compact, phone-friendly list — name + status + an Edit button to the detail page. */
export async function render(_req: Request): Promise<string> {
  const pool = adminWritePool();

  const res = await pool.query<TargetRow>(
    "SELECT id, name, web_url, social, active, platform FROM targets ORDER BY name",
  );
  const rows = res.rows;

  const tableRows = rows
    .map(
      (t) => `
      <tr>
        <td>
          <div class="t-name">${esc(t.name)}</div>
          ${t.platform ? `<div class="t-sub">${esc(t.platform)}</div>` : ""}
        </td>
        <td><span class="pill ${t.active ? "pill-on" : "pill-off"}">${t.active ? "On" : "Off"}</span></td>
        <td><a class="btn btn-sm btn-primary" href="/admin/targets/${esc(t.id)}">Edit</a></td>
      </tr>`,
    )
    .join("\n");

  return `
    <table class="tbl-compact">
      <thead>
        <tr><th>Competitor</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        ${tableRows || '<tr><td colspan="3" class="muted">No targets found.</td></tr>'}
      </tbody>
    </table>
    <p class="note">
      Tap <strong>Edit</strong> to manage a competitor's website &amp; social links.
      Changes apply on the next daily run (03:15).
    </p>
  `;
}

/** Edit page for a single target — where the actual website &amp; social links live. */
export async function renderEdit(req: Request): Promise<{ title: string; body: string }> {
  const admin = (req as AdminReq).admin;
  const id = String((req.params as Record<string, string>).id ?? "").trim();
  const pool = adminWritePool();

  const res = await pool.query<TargetRow>(
    "SELECT id, name, web_url, social, active, platform FROM targets WHERE id = $1",
    [id],
  );
  const t = res.rows[0];

  if (!t) {
    return {
      title: "Targets",
      body: `
        <p class="error">Target not found.</p>
        <p><a class="btn" style="border-color:var(--border);color:var(--slate);" href="/admin/targets">← Back to targets</a></p>
      `,
    };
  }

  const body = `
    <p class="note" style="margin:-.5rem 0 1.25rem;">
      <a href="/admin/targets">← Targets</a>
      &nbsp;·&nbsp; Platform: <strong>${esc(t.platform ?? "—")}</strong>
      &nbsp;·&nbsp; ID: <code>${esc(t.id)}</code>
    </p>
    <div class="card">
      <form method="POST" action="/admin/targets">
        ${csrfField(admin.csrf)}
        <input type="hidden" name="action" value="save">
        <input type="hidden" name="id" value="${esc(t.id)}">

        <label for="f-web">Website URL</label>
        <input id="f-web" type="url" name="web_url" placeholder="https://…"
          value="${esc(t.web_url ?? "")}">

        <label for="f-ig">Instagram URL</label>
        <input id="f-ig" type="text" name="instagram" placeholder="https://instagram.com/…"
          value="${esc(socialHandle(t.social, "instagram"))}">

        <label for="f-fb">Facebook URL</label>
        <input id="f-fb" type="text" name="facebook" placeholder="https://facebook.com/…"
          value="${esc(socialHandle(t.social, "facebook"))}">

        <label for="f-tt">TikTok URL</label>
        <input id="f-tt" type="text" name="tiktok" placeholder="https://tiktok.com/@…"
          value="${esc(socialHandle(t.social, "tiktok"))}">

        <label style="font-weight:500;margin-top:.4rem;">
          <input type="checkbox" name="active" value="1"${t.active ? " checked" : ""}>
          Active — include in daily runs
        </label>

        <div style="display:flex;gap:.6rem;margin-top:1.1rem;">
          <button type="submit" class="btn btn-primary">Save changes</button>
          <a class="btn" style="border-color:var(--border);color:var(--slate);" href="/admin/targets">Cancel</a>
        </div>
      </form>
    </div>
  `;

  return { title: `Edit ${t.name}`, body };
}

export async function submit(
  req: Request,
): Promise<{ redirect: string; flash?: string } | { error: string }> {
  const admin = (req as AdminReq).admin;
  const body = (req as AdminReq).body;

  if (!checkCsrf(admin.csrf, body.csrf)) {
    return { error: "Bad CSRF" };
  }

  const action = String(body.action ?? "");

  if (action === "save") {
    const id = String(body.id ?? "").trim();
    if (!id) return { error: "Missing target id" };

    const webUrl = String(body.web_url ?? "").trim();
    if (webUrl && !URL_RE.test(webUrl)) {
      return { error: `Invalid web URL: ${webUrl}` };
    }

    const instagram = String(body.instagram ?? "").trim() || null;
    const facebook = String(body.facebook ?? "").trim() || null;
    const tiktok = String(body.tiktok ?? "").trim() || null;

    // D7: validate platform URLs against expected hosts.
    const igErr = instagram ? validatePlatformUrl(instagram, "Instagram", "instagram.com") : null;
    if (igErr) return { error: igErr };
    const fbErr = facebook ? validatePlatformUrl(facebook, "Facebook", "facebook.com") : null;
    if (fbErr) return { error: fbErr };
    const ttErr = tiktok ? validatePlatformUrl(tiktok, "TikTok", "tiktok.com") : null;
    if (ttErr) return { error: ttErr };
    const active = body.active === "1" || body.active === "on";

    const social: Record<string, string> = {};
    if (instagram) social.instagram = instagram;
    if (facebook) social.facebook = facebook;
    if (tiktok) social.tiktok = tiktok;

    const socialJson = JSON.stringify(social);
    const webUrlVal = webUrl || null;

    const pool = adminWritePool();
    await pool.query(
      `UPDATE targets
       SET web_url = $1, social = $2::jsonb, active = $3, updated_at = now()
       WHERE id = $4`,
      [webUrlVal, socialJson, active, id],
    );

    return { redirect: "/admin/targets", flash: `Saved target ${id}` };
  }

  return { error: `Unknown action: ${action}` };
}
