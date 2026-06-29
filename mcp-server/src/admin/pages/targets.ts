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

function socialHandle(social: Record<string, string> | null, key: string): string {
  if (!social || typeof social !== "object") return "";
  const val = (social as Record<string, unknown>)[key];
  return typeof val === "string" ? val : "";
}

export async function render(req: Request): Promise<string> {
  const admin = (req as AdminReq).admin;
  const pool = adminWritePool();

  const res = await pool.query<TargetRow>(
    "SELECT id, name, web_url, social, active, platform FROM targets ORDER BY name",
  );
  const rows = res.rows;

  const tableRows = rows
    .map(
      (t) => `
      <tr>
        <td style="white-space:nowrap;">${esc(t.id)}</td>
        <td>${esc(t.name)}</td>
        <td>${esc(t.platform ?? "")}</td>
        <td colspan="5">
          <form method="POST" action="/admin/targets" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:.4rem;align-items:center;">
            ${csrfField(admin.csrf)}
            <input type="hidden" name="action" value="save">
            <input type="hidden" name="id" value="${esc(t.id)}">
            <input type="url" name="web_url" placeholder="https://…"
              value="${esc(t.web_url ?? "")}" style="margin-bottom:0;">
            <input type="text" name="instagram" placeholder="instagram URL"
              value="${esc(socialHandle(t.social, "instagram"))}" style="margin-bottom:0;">
            <input type="text" name="facebook" placeholder="facebook URL"
              value="${esc(socialHandle(t.social, "facebook"))}" style="margin-bottom:0;">
            <input type="text" name="tiktok" placeholder="tiktok URL"
              value="${esc(socialHandle(t.social, "tiktok"))}" style="margin-bottom:0;">
            <div style="display:flex;align-items:center;gap:.5rem;white-space:nowrap;">
              <label style="display:flex;align-items:center;gap:.25rem;margin-bottom:0;font-weight:normal;">
                <input type="checkbox" name="active" value="1"${t.active ? " checked" : ""}> Active
              </label>
              <button type="submit" class="btn btn-primary btn-sm">Save</button>
            </div>
          </form>
        </td>
      </tr>`,
    )
    .join("\n");

  return `
    <p class="note" style="margin-bottom:1rem;">
      Changes apply on the next daily run. Columns after Platform: web URL, Instagram, Facebook, TikTok.
    </p>
    <div class="card" style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Platform</th>
            <th>Web URL</th>
            <th>Instagram</th>
            <th>Facebook</th>
            <th>TikTok</th>
            <th>Active / Save</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="8" style="color:#999;">No targets found.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
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
    const active = body.active === "1" || body.active === "on";

    const social: Record<string, string> = {};
    if (instagram) social["instagram"] = instagram;
    if (facebook) social["facebook"] = facebook;
    if (tiktok) social["tiktok"] = tiktok;

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
