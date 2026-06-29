import { getSetting } from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb, adminWritePool } from "../../writePool.js";

export async function render(_req: Request): Promise<string> {
  const db = adminWriteDb();
  const pool = adminWritePool();

  const usersRes = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM authorized_users WHERE active = true",
  );
  const userCount = Number(usersRes.rows[0]?.n ?? 0);

  const targetsRes = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM targets WHERE web_enabled = true AND active = true",
  );
  const targetCount = Number(targetsRes.rows[0]?.n ?? 0);

  const recipients: string[] = await getSetting(db, "digest_recipients", ["dragan@mytime.mk"]);
  const recipientCount = recipients.length;

  return `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:2rem;">
      <div class="card" style="text-align:center;">
        <div style="font-size:2rem;font-weight:700;">${userCount}</div>
        <div>Active Users</div>
        <a href="/admin/users" class="note">Manage →</a>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:2rem;font-weight:700;">${targetCount}</div>
        <div>Web-Enabled Targets</div>
        <a href="/admin/targets" class="note">Manage →</a>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:2rem;font-weight:700;">${recipientCount}</div>
        <div>Digest Recipients</div>
        <a href="/admin/recipients" class="note">Manage →</a>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;font-size:1rem;">Quick Links</h2>
      <ul>
        <li><a href="/admin/users">Manage authorized users</a></li>
        <li><a href="/admin/recipients">Digest recipients</a></li>
        <li><a href="/admin/settings">Application settings</a></li>
        <li><a href="/admin/targets">Targets (web URLs, social, active)</a></li>
      </ul>
    </div>
  `;
}
