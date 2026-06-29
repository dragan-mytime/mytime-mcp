import { listPrompts, listSchedules } from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb } from "../../writePool.js";
import { esc } from "../render.js";

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
        <td>${esc(s.sendAt)}</td>
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
