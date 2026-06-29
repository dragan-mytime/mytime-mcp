import { allSettings, maskGeminiKey, setSetting } from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb } from "../../writePool.js";
import { isSuperAdmin } from "../auth.js";
import { csrfField, esc } from "../render.js";
import { checkCsrf } from "../session.js";

interface AdminReq extends Request {
  admin: { email: string; csrf: string };
  body: Record<string, unknown>;
}

interface SettingsDefaults {
  discount_threshold_pct: number;
  ad_results_limit: number;
  web_max_products: number;
  digest_enabled: boolean;
}

const DEFAULTS: SettingsDefaults = {
  discount_threshold_pct: 5,
  ad_results_limit: 50,
  web_max_products: 100000,
  digest_enabled: true,
};

export async function render(req: Request): Promise<string> {
  const admin = (req as AdminReq).admin;
  const db = adminWriteDb();

  const stored = await allSettings(db);
  const vals = {
    discount_threshold_pct: Number(
      stored["discount_threshold_pct"] ?? DEFAULTS.discount_threshold_pct,
    ),
    ad_results_limit: Number(stored["ad_results_limit"] ?? DEFAULTS.ad_results_limit),
    web_max_products: Number(stored["web_max_products"] ?? DEFAULTS.web_max_products),
    digest_enabled: Boolean(stored["digest_enabled"] ?? DEFAULTS.digest_enabled),
  };

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
          <small class="note">Minimum discount % to flag in digest alerts</small>
          <input type="number" name="discount_threshold_pct" min="1" max="100"
            value="${esc(vals.discount_threshold_pct)}">
        </label>

        <label>Ad results limit<br>
          <small class="note">Max ad observations returned per target per run</small>
          <input type="number" name="ad_results_limit" min="1" max="500"
            value="${esc(vals.ad_results_limit)}">
        </label>

        <label>Web max products<br>
          <small class="note">Upper cap on products scraped per target per run</small>
          <input type="number" name="web_max_products" min="100" max="1000000"
            value="${esc(vals.web_max_products)}">
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

  const discountPct = Number(body["discount_threshold_pct"]);
  const adLimit = Number(body["ad_results_limit"]);
  const webMax = Number(body["web_max_products"]);
  const digestEnabled = body["digest_enabled"] === "1" || body["digest_enabled"] === "on";

  if (!Number.isInteger(discountPct) || discountPct < 1 || discountPct > 100) {
    return { error: "Discount threshold must be an integer between 1 and 100" };
  }
  if (!Number.isInteger(adLimit) || adLimit < 1 || adLimit > 500) {
    return { error: "Ad results limit must be an integer between 1 and 500" };
  }
  if (!Number.isInteger(webMax) || webMax < 100 || webMax > 1_000_000) {
    return { error: "Web max products must be an integer between 100 and 1 000 000" };
  }

  const db = adminWriteDb();
  await setSetting(db, "discount_threshold_pct", discountPct);
  await setSetting(db, "ad_results_limit", adLimit);
  await setSetting(db, "web_max_products", webMax);
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
