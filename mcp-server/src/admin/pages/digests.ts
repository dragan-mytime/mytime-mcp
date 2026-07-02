import {
  type DigestPeriod,
  dailyDigest,
  deletePrompt,
  deleteSchedule,
  getPrompt,
  getSchedule,
  listPrompts,
  listSchedules,
  parseDigestPeriod,
  parseRecipients,
  renderDigestWithPrompt,
  resolveGeminiKey,
  sendDigestEmail,
  upsertPrompt,
  upsertSchedule,
  validRecipients,
  validSendAt,
} from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb } from "../../writePool.js";
import { csrfField, esc } from "../render.js";
import { checkCsrf } from "../session.js";

interface AdminReq extends Request {
  admin: { email: string; csrf: string };
  body: Record<string, unknown>;
}

export async function render(_req: Request): Promise<string> {
  const db = adminWriteDb();
  const [prompts, schedules] = await Promise.all([listPrompts(db), listSchedules(db)]);

  const promptRows = prompts
    .map(
      (p) => `
      <tr>
        <td><div class="t-name">${esc(p.name)}</div><div class="t-sub">${esc(p.id)}</div></td>
        <td>${esc(p.updatedAt.toISOString().slice(0, 10))}</td>
        <td><a class="btn btn-sm btn-primary" href="/admin/digests/prompts/${esc(p.id)}">Edit</a></td>
      </tr>`,
    )
    .join("\n");

  const scheduleRows = schedules
    .map(
      (s) => `
      <tr>
        <td><div class="t-name">${esc(s.name)}</div><div class="t-sub">${esc(s.promptName)}</div></td>
        <td>${esc(s.sendAt)}${parseDigestPeriod(s.period) === "weekly" ? ' <span class="t-sub">weekly</span>' : ""}</td>
        <td><span class="pill ${s.enabled ? "pill-on" : "pill-off"}">${s.enabled ? "On" : "Off"}</span></td>
        <td><a class="btn btn-sm btn-primary" href="/admin/digests/schedules/${esc(s.id)}">Edit</a></td>
      </tr>`,
    )
    .join("\n");

  return `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;">
        <h2 style="margin:0;">Prompts</h2>
        <a class="btn btn-sm btn-primary" href="/admin/digests/prompts/new">＋ New prompt</a>
      </div>
      <table class="tbl-compact">
        <thead><tr><th>Prompt</th><th>Updated</th><th></th></tr></thead>
        <tbody>${promptRows || '<tr><td colspan="3" class="muted">No prompts yet.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;">
        <h2 style="margin:0;">Schedulers</h2>
        <a class="btn btn-sm btn-primary" href="/admin/digests/schedules/new">＋ New scheduler</a>
      </div>
      <table class="tbl-compact">
        <thead><tr><th>Scheduler</th><th>Time</th><th>Status</th><th></th></tr></thead>
        <tbody>${scheduleRows || '<tr><td colspan="4" class="muted">No schedulers yet.</td></tr>'}</tbody>
      </table>
    </div>

    <p class="note">Times are Europe/Skopje. Edit a prompt to preview or send a test before scheduling it.</p>
  `;
}

// ── Prompt editor ──────────────────────────────────────────────────────────

function promptForm(
  admin: { csrf: string },
  prompt: { id: string; name: string; body: string } | null,
  preview?: { subject: string; html: string; usedFallback: boolean } | { error: string },
): string {
  const isNew = prompt == null;
  const id = prompt?.id ?? "new";

  let previewBlock = "";
  if (preview && "error" in preview) {
    previewBlock = `<p class="error" style="margin-top:1rem;">${esc(preview.error)}</p>`;
  } else if (preview) {
    const fallbackNote = preview.usedFallback
      ? `<p class="note">⚠ Gemini was unavailable — showing the deterministic template fallback.</p>`
      : "";
    previewBlock = `
      <h2 style="margin-top:1.5rem;">Preview</h2>
      <p class="note">Subject: <strong>${esc(preview.subject)}</strong></p>
      ${fallbackNote}
      <iframe class="preview-frame" sandbox srcdoc="${esc(preview.html)}" title="Email preview"></iframe>`;
  }

  return `
    <p class="note" style="margin:-.5rem 0 1.25rem;"><a href="/admin/digests">← Digests</a></p>
    <div class="card">
      <form method="POST" action="/admin/digests/prompts">
        ${csrfField(admin.csrf)}
        ${isNew ? "" : `<input type="hidden" name="id" value="${esc(id)}">`}
        <label for="f-name">Name</label>
        <input id="f-name" type="text" name="name" value="${esc(prompt?.name ?? "")}" placeholder="Daily competitor digest">
        <label for="f-body">Prompt</label>
        <textarea id="f-body" class="mono" name="body" placeholder="You are a competitive-intelligence analyst…">${esc(prompt?.body ?? "")}</textarea>
        <div style="display:flex;flex-wrap:wrap;gap:.6rem;margin-top:.4rem;">
          <button type="submit" class="btn btn-primary" name="action" value="save">Save</button>
          <button type="submit" class="btn" style="border-color:var(--border);color:var(--slate);" formaction="/admin/digests/prompts/${esc(id)}/preview">Preview</button>
          <button type="submit" class="btn" style="border-color:var(--border);color:var(--slate);" formaction="/admin/digests/prompts/${esc(id)}/test">Send test to me</button>
          ${isNew ? "" : `<button type="submit" class="btn btn-danger" name="action" value="delete" formnovalidate>Delete</button>`}
          <a class="btn" style="border-color:var(--border);color:var(--slate);" href="/admin/digests">Cancel</a>
        </div>
      </form>
      ${previewBlock}
    </div>
  `;
}

export async function renderPromptEdit(req: Request): Promise<{ title: string; body: string }> {
  const admin = (req as AdminReq).admin;
  const id = String((req.params as Record<string, string>).id ?? "").trim();
  if (id === "new") return { title: "New prompt", body: promptForm(admin, null) };
  const db = adminWriteDb();
  const prompt = await getPrompt(db, id);
  if (!prompt) {
    return {
      title: "Digests",
      body: `<p class="error">Prompt not found.</p><p><a class="btn" style="border-color:var(--border);color:var(--slate);" href="/admin/digests">← Back</a></p>`,
    };
  }
  return { title: `Edit ${prompt.name}`, body: promptForm(admin, prompt) };
}

export async function submitPrompt(
  req: Request,
): Promise<{ redirect: string; flash?: string } | { error: string }> {
  const admin = (req as AdminReq).admin;
  const body = (req as AdminReq).body;
  if (!checkCsrf(admin.csrf, body.csrf)) return { error: "Bad CSRF" };
  const db = adminWriteDb();
  const action = String(body.action ?? "");
  const id = String(body.id ?? "").trim();

  if (action === "delete") {
    if (!id) return { error: "Missing prompt id" };
    try {
      await deletePrompt(db, id);
    } catch {
      return {
        error: "Cannot delete: a scheduler still uses this prompt. Remove the scheduler first.",
      };
    }
    return { redirect: "/admin/digests", flash: `Deleted prompt ${id}` };
  }

  if (action === "save") {
    const name = String(body.name ?? "").trim();
    const promptBody = String(body.body ?? "").trim();
    if (!name) return { error: "Name is required" };
    if (!promptBody) return { error: "Prompt body is required" };
    if (promptBody.length > 8192) return { error: "Prompt is too long (max 8 KB)" };
    const savedId = await upsertPrompt(db, { id: id || undefined, name, body: promptBody });
    return { redirect: `/admin/digests/prompts/${savedId}`, flash: `Saved ${name}` };
  }

  return { error: `Unknown action: ${action}` };
}

/** Render a live preview using the posted (possibly unsaved) body + today's real data. */
export async function previewPrompt(req: Request): Promise<{ title: string; body: string }> {
  const admin = (req as AdminReq).admin;
  const reqBody = (req as AdminReq).body;
  const id = String((req.params as Record<string, string>).id ?? "").trim();
  const name = String(reqBody.name ?? "").trim();
  const promptBody = String(reqBody.body ?? "").trim();
  const prompt = { id: id === "new" ? "new" : id, name, body: promptBody };

  if (!checkCsrf(admin.csrf, reqBody.csrf)) {
    return { title: "Preview", body: promptForm(admin, prompt, { error: "Bad CSRF" }) };
  }
  if (!promptBody) {
    return {
      title: "Preview",
      body: promptForm(admin, prompt, { error: "Enter a prompt to preview" }),
    };
  }
  try {
    const db = adminWriteDb();
    const digest = await dailyDigest(db);
    const apiKey = await resolveGeminiKey(db);
    const rendered = await renderDigestWithPrompt(digest, promptBody, apiKey);
    return { title: name || "Preview", body: promptForm(admin, prompt, rendered) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      title: "Preview",
      body: promptForm(admin, prompt, { error: `Preview failed: ${msg}` }),
    };
  }
}

/** Send a test email of the posted body to the logged-in admin. */
export async function testPrompt(
  req: Request,
): Promise<{ redirect: string; flash?: string } | { error: string }> {
  const admin = (req as AdminReq).admin;
  const reqBody = (req as AdminReq).body;
  const id = String((req.params as Record<string, string>).id ?? "").trim();
  if (!checkCsrf(admin.csrf, reqBody.csrf)) return { error: "Bad CSRF" };
  const promptBody = String(reqBody.body ?? "").trim();
  if (!promptBody) return { error: "Enter a prompt before sending a test" };
  try {
    const db = adminWriteDb();
    const digest = await dailyDigest(db);
    const apiKey = await resolveGeminiKey(db);
    const rendered = await renderDigestWithPrompt(digest, promptBody, apiKey);
    await sendDigestEmail(rendered, [admin.email]);
  } catch (err) {
    return { error: `Test send failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const dest = id && id !== "new" ? `/admin/digests/prompts/${id}` : "/admin/digests";
  return { redirect: dest, flash: `Test sent to ${admin.email}` };
}

// ── Scheduler editor ───────────────────────────────────────────────────────

function scheduleForm(
  admin: { csrf: string },
  schedule: {
    id: string;
    name: string;
    promptId: string;
    sendAt: string;
    period: DigestPeriod;
    recipients: string[] | null;
    enabled: boolean;
  } | null,
  prompts: { id: string; name: string }[],
): string {
  const isNew = schedule == null;
  const id = schedule?.id ?? "new";
  const options = prompts
    .map(
      (p) =>
        `<option value="${esc(p.id)}"${schedule?.promptId === p.id ? " selected" : ""}>${esc(p.name)}</option>`,
    )
    .join("");
  const recipientsText = (schedule?.recipients ?? []).join("\n");

  return `
    <p class="note" style="margin:-.5rem 0 1.25rem;"><a href="/admin/digests">← Digests</a></p>
    <div class="card">
      <form method="POST" action="/admin/digests/schedules">
        ${csrfField(admin.csrf)}
        ${isNew ? "" : `<input type="hidden" name="id" value="${esc(id)}">`}
        <label for="s-name">Name</label>
        <input id="s-name" type="text" name="name" value="${esc(schedule?.name ?? "")}" placeholder="Daily 07:00">
        <label for="s-prompt">Prompt</label>
        <select id="s-prompt" name="prompt_id">${options || '<option value="">— no prompts —</option>'}</select>
        <label for="s-time">Send at (Europe/Skopje)</label>
        <input id="s-time" type="time" name="send_at" value="${esc(schedule?.sendAt ?? "07:00")}">
        <label for="s-period">Period</label>
        <select id="s-period" name="period">
          <option value="daily"${schedule?.period !== "weekly" ? " selected" : ""}>Daily (day-over-day)</option>
          <option value="weekly"${schedule?.period === "weekly" ? " selected" : ""}>Weekly (vs ~7 days earlier)</option>
        </select>
        <label for="s-rcpt">Recipients (one per line; blank = use global Recipients)</label>
        <textarea id="s-rcpt" name="recipients" placeholder="name@example.com">${esc(recipientsText)}</textarea>
        <label style="font-weight:500;margin-top:.4rem;">
          <input type="checkbox" name="enabled" value="1"${schedule?.enabled !== false ? " checked" : ""}> Enabled
        </label>
        <div style="display:flex;flex-wrap:wrap;gap:.6rem;margin-top:1.1rem;">
          <button type="submit" class="btn btn-primary" name="action" value="save">Save</button>
          ${isNew ? "" : `<button type="submit" class="btn btn-danger" name="action" value="delete" formnovalidate>Delete</button>`}
          <a class="btn" style="border-color:var(--border);color:var(--slate);" href="/admin/digests">Cancel</a>
        </div>
      </form>
    </div>
  `;
}

export async function renderScheduleEdit(req: Request): Promise<{ title: string; body: string }> {
  const admin = (req as AdminReq).admin;
  const id = String((req.params as Record<string, string>).id ?? "").trim();
  const db = adminWriteDb();
  const prompts = await listPrompts(db);
  if (id === "new") {
    return { title: "New scheduler", body: scheduleForm(admin, null, prompts) };
  }
  const schedule = await getSchedule(db, id);
  if (!schedule) {
    return {
      title: "Digests",
      body: `<p class="error">Scheduler not found.</p><p><a class="btn" style="border-color:var(--border);color:var(--slate);" href="/admin/digests">← Back</a></p>`,
    };
  }
  return {
    title: `Edit ${schedule.name}`,
    body: scheduleForm(
      admin,
      {
        id: schedule.id,
        name: schedule.name,
        promptId: schedule.promptId,
        sendAt: schedule.sendAt,
        period: parseDigestPeriod(schedule.period),
        recipients: (schedule.recipients as string[] | null) ?? null,
        enabled: schedule.enabled,
      },
      prompts,
    ),
  };
}

export async function submitSchedule(
  req: Request,
): Promise<{ redirect: string; flash?: string } | { error: string }> {
  const admin = (req as AdminReq).admin;
  const body = (req as AdminReq).body;
  if (!checkCsrf(admin.csrf, body.csrf)) return { error: "Bad CSRF" };
  const db = adminWriteDb();
  const action = String(body.action ?? "");
  const id = String(body.id ?? "").trim();

  if (action === "delete") {
    if (!id) return { error: "Missing scheduler id" };
    await deleteSchedule(db, id);
    return { redirect: "/admin/digests", flash: `Deleted scheduler ${id}` };
  }

  if (action === "save") {
    const name = String(body.name ?? "").trim();
    const promptId = String(body.prompt_id ?? "").trim();
    const sendAt = String(body.send_at ?? "").trim();
    if (!name) return { error: "Name is required" };
    if (!promptId) return { error: "Pick a prompt (create one first if none exist)" };
    if (!validSendAt(sendAt)) return { error: `Invalid send time: ${sendAt}` };
    const recipients = parseRecipients(String(body.recipients ?? ""));
    if (recipients.length > 0 && !validRecipients(recipients)) {
      return { error: "One or more recipients are not valid email addresses" };
    }
    const enabled = body.enabled === "1" || body.enabled === "on";
    const period = parseDigestPeriod(body.period);
    await upsertSchedule(db, {
      id: id || undefined,
      name,
      promptId,
      sendAt,
      period,
      recipients: recipients.length > 0 ? recipients : null,
      enabled,
    });
    return { redirect: "/admin/digests", flash: `Saved ${name}` };
  }

  return { error: `Unknown action: ${action}` };
}
