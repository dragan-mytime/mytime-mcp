import type { Request } from "express";
import { adminWritePool } from "../../writePool.js";
import { csrfField, esc } from "../render.js";
import { checkCsrf } from "../session.js";

interface AdminReq extends Request {
  admin: { email: string; csrf: string };
  body: Record<string, unknown>;
}

interface UserRow {
  email: string;
  role: string;
  active: boolean;
  name: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["admin", "analyst", "viewer"]);

export async function render(req: Request): Promise<string> {
  const admin = (req as AdminReq).admin;
  const pool = adminWritePool();

  const res = await pool.query<UserRow>(
    "SELECT email, role, active, name FROM authorized_users ORDER BY email",
  );
  const rows = res.rows;

  const tableRows = rows
    .map(
      (u) => `
      <tr>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role)}</td>
        <td>${u.active ? "✓" : ""}</td>
        <td>${esc(u.name ?? "")}</td>
        <td>
          <form method="POST" action="/admin/users" class="inline-form">
            ${csrfField(admin.csrf)}
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="email" value="${esc(u.email)}">
            <button type="submit" class="btn btn-danger btn-sm"
              onclick="return confirm('Delete ${esc(u.email)}?')">Delete</button>
          </form>
        </td>
      </tr>`,
    )
    .join("\n");

  return `
    <div class="card">
      <table>
        <thead>
          <tr><th>Email</th><th>Role</th><th>Active</th><th>Name</th><th></th></tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="5" style="color:#999;">No users yet.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Add / Update User</h2>
      <form method="POST" action="/admin/users">
        ${csrfField(admin.csrf)}
        <input type="hidden" name="action" value="save">
        <label>Email<input type="email" name="email" required></label>
        <label>Name<input type="text" name="name"></label>
        <label>Role
          <select name="role">
            <option value="viewer">viewer</option>
            <option value="analyst">analyst</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;">
          <input type="checkbox" name="active" value="1" checked> Active
        </label>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
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
  const pool = adminWritePool();

  if (action === "delete") {
    const email = String(body.email ?? "")
      .toLowerCase()
      .trim();
    if (!email) return { error: "Missing email" };
    await pool.query("DELETE FROM authorized_users WHERE email = $1", [email]);
    return { redirect: "/admin/users", flash: `Deleted ${email}` };
  }

  if (action === "save") {
    const email = String(body.email ?? "")
      .toLowerCase()
      .trim();
    const name = String(body.name ?? "").trim() || null;
    const role = String(body.role ?? "viewer");
    const active = body.active === "1" || body.active === "on" || body.active === true;

    if (!EMAIL_RE.test(email)) return { error: "Invalid email address" };
    if (!VALID_ROLES.has(role)) return { error: "Invalid role" };

    await pool.query(
      `INSERT INTO authorized_users (email, role, active, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET role = EXCLUDED.role,
             active = EXCLUDED.active,
             name = EXCLUDED.name,
             updated_at = now()`,
      [email, role, active, name],
    );

    return { redirect: "/admin/users", flash: `Saved ${email}` };
  }

  return { error: `Unknown action: ${action}` };
}
