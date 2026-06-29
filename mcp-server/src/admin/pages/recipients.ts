import { getSetting, setSetting } from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb } from "../../writePool.js";
import { csrfField, esc } from "../render.js";
import { checkCsrf } from "../session.js";

interface AdminReq extends Request {
  admin: { email: string; csrf: string };
  body: Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function render(req: Request): Promise<string> {
  const admin = (req as AdminReq).admin;
  const db = adminWriteDb();

  const recipients: string[] = await getSetting(db, "digest_recipients", ["dragan@mytime.mk"]);
  const textareaValue = esc(recipients.join("\n"));

  return `
    <div class="card">
      <p>One email address per line. These addresses receive the daily digest.</p>
      <form method="POST" action="/admin/recipients">
        ${csrfField(admin.csrf)}
        <label>Recipients
          <textarea name="recipients" rows="8">${textareaValue}</textarea>
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

  const raw = String(body.recipients ?? "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const invalid = lines.filter((l) => !EMAIL_RE.test(l));
  if (invalid.length > 0) {
    return { error: `Invalid email(s): ${invalid.join(", ")}` };
  }

  const db = adminWriteDb();
  await setSetting(db, "digest_recipients", lines);

  return { redirect: "/admin/recipients", flash: `Saved ${lines.length} recipient(s)` };
}
