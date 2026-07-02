import { allSettings, maskGeminiKey, parseAppSettings, parsePosInt, setSetting } from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb } from "../../writePool.js";
import { isSuperAdmin } from "../auth.js";
import { csrfField, esc } from "../render.js";
import { checkCsrf } from "../session.js";

interface AdminReq extends Request {
  admin: { email: string; csrf: string };
  body: Record<string, unknown>;
}

export async function render(req: Request): Promise<string> {
  const admin = (req as AdminReq).admin;
  const db = adminWriteDb();

  const stored = await allSettings(db);
  // Single source of truth for defaults/parsing: @mytime/db (parseAppSettings /
  // parsePosInt). Numeric inputs show a value only when one is stored and valid;
  // otherwise they render blank with the effective default in the placeholder.
  // Blank fields are skipped on save (see submit), so saving the form never
  // silently persists a default the readers didn't already apply.
  const vals = {
    discount_threshold_pct: parsePosInt(stored.discount_threshold_pct),
    ad_results_limit: parsePosInt(stored.ad_results_limit),
    web_max_products: parsePosInt(stored.web_max_products),
    digest_enabled: parseAppSettings(stored).digestEnabled,
  };
  const numVal = (v: number | null): string => (v == null ? "" : String(v));

  const checkedAttr = vals.digest_enabled ? " checked" : "";

  // Super-admin only: the Gemini API key (masked, never echoed in full).
  const geminiStored =
    typeof stored["gemini_api_key"] === "string" ? stored["gemini_api_key"] : null;
  const geminiField = isSuperAdmin(admin.email)
    ? `
        <hr style="border:none;border-top:1px solid var(--border);margin:1.25rem 0;">
        <label>Gemini API key<br>
          <small class="note">
            Current: <strong>${esc(maskGeminiKey(geminiStored))}</strong>.
            Paste a new key to replace it; leave blank to keep. Drives digest AI narration.
          </small>
          <input type="password" name="gemini_api_key" autocomplete="off"
            placeholder="AIza… (leave blank to keep current)">
        </label>
        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;">
          <input type="checkbox" name="gemini_api_key_remove" value="1">
          Remove stored key (fall back to server .env)
        </label>`
    : "";

  return `
    <div class="card">
      <form method="POST" action="/admin/settings">
        ${csrfField(admin.csrf)}

        <label>Discount threshold (%)<br>
          <small class="note">Minimum price-move % flagged in digest + dashboard. Blank = default 5.</small>
          <input type="number" name="discount_threshold_pct" min="1" max="100"
            value="${esc(numVal(vals.discount_threshold_pct))}" placeholder="unset — default 5">
        </label>

        <label>Ad results limit<br>
          <small class="note">Max ad observations returned per target per run. Blank = default 50.</small>
          <input type="number" name="ad_results_limit" min="1" max="500"
            value="${esc(numVal(vals.ad_results_limit))}" placeholder="unset — default 50">
        </label>

        <label>Web max products<br>
          <small class="note">Upper cap on products scraped per target per run.
            Blank = server WEB_MAX_PRODUCTS env, else 300.</small>
          <input type="number" name="web_max_products" min="100" max="1000000"
            value="${esc(numVal(vals.web_max_products))}" placeholder="unset — env WEB_MAX_PRODUCTS, else 300">
        </label>

        <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;">
          <input type="checkbox" name="digest_enabled" value="1"${checkedAttr}>
          Digest enabled
        </label>
        ${geminiField}

        <button type="submit" class="btn btn-primary">Save</button>
      </form>
      <p class="note" style="margin-top:1rem;">
        Daily run time is 03:15 UTC (systemd timer — not editable here).
      </p>
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

  // Blank numeric field = "leave unset" — never persisted, so the readers'
  // built-in defaults (5 / 50 / env→300) stay in effect. Non-blank values are
  // range-validated then stored.
  const numeric: { key: string; min: number; max: number; label: string }[] = [
    { key: "discount_threshold_pct", min: 1, max: 100, label: "Discount threshold" },
    { key: "ad_results_limit", min: 1, max: 500, label: "Ad results limit" },
    { key: "web_max_products", min: 100, max: 1_000_000, label: "Web max products" },
  ];
  const toStore: { key: string; value: number }[] = [];
  for (const f of numeric) {
    const rawVal = String(body[f.key] ?? "").trim();
    if (rawVal === "") continue; // untouched/blank → leave unset
    const n = Number(rawVal);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      return {
        error: `${f.label} must be an integer between ${f.min} and ${f.max.toLocaleString("en")}`,
      };
    }
    toStore.push({ key: f.key, value: n });
  }
  const digestEnabled = body["digest_enabled"] === "1" || body["digest_enabled"] === "on";

  const db = adminWriteDb();
  for (const s of toStore) await setSetting(db, s.key, s.value);
  await setSetting(db, "digest_enabled", digestEnabled);

  // Gemini API key — super-admin only; never trust the form for the gate.
  if (isSuperAdmin(admin.email)) {
    const remove = body["gemini_api_key_remove"] === "1" || body["gemini_api_key_remove"] === "on";
    const newKey = String(body["gemini_api_key"] ?? "").trim();
    if (remove) {
      // Store "" (not null) — the value column is jsonb NOT NULL; resolveGeminiKey
      // treats an empty string as "not set" and falls back to the server .env.
      await setSetting(db, "gemini_api_key", "");
    } else if (newKey) {
      await setSetting(db, "gemini_api_key", newKey);
    }
    // blank + not removing → leave the stored key unchanged
  }

  return { redirect: "/admin/settings", flash: "Settings saved" };
}
