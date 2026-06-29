import { optionalEnv } from "@mytime/shared";
import type { CompetitorDigest, DigestResult } from "./digest.js";

const MODEL = "gemini-2.5-flash";

function esc(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function competitorBlock(c: CompetitorDigest, lang: "en" | "mk"): string {
  const isEn = lang === "en";
  const salesLabel = isEn ? "Sales" : "Продажби";
  const onSaleLabel = isEn ? "On sale today" : "Денес на попуст";
  const avgPctLabel = isEn ? "Avg. discount" : "Просечен попуст";
  const newlyDiscLabel = isEn ? "Newly discounted" : "Ново на попуст";
  const endedLabel = isEn ? "Ended" : "Завршиле";
  const adsLabel = isEn ? "Ads" : "Огласи";
  const activeTodayLabel = isEn ? "Active today" : "Активни денес";
  const newAdsLabel = isEn ? "New ads" : "Нови огласи";
  const longestLabel = isEn ? "Longest-running" : "Најдолго активен";
  const socialLabel = isEn ? "Social" : "Социјални мрежи";
  const followerDeltaLabel = isEn ? "Follower change" : "Промена на следачи";
  const inventoryLabel = isEn ? "Inventory" : "Залихи";
  const newProductsLabel = isEn ? "New products" : "Нови производи";
  const stockoutsLabel = isEn ? "New stockouts" : "Ново без залихи";
  const priceMovesLabel = isEn ? "Price moves (>5%)" : "Промени на цени (>5%)";
  const noDataLabel = isEn ? "none" : "нема";

  const { sales, ads, social, inventory } = c;
  const avgPctStr = sales.avgPct != null ? `${sales.avgPct.toFixed(1)}%` : noDataLabel;
  const longestRunningStr =
    ads.longestRunning != null
      ? `${esc(ads.longestRunning.adTitle)} (${ads.longestRunning.daysRunning ?? "?"} ${isEn ? "days" : "дена"})`
      : noDataLabel;
  const followerLines = Object.entries(social.followers)
    .map(([p, d]) => `<li>${esc(p)}: ${d >= 0 ? "+" : ""}${d}</li>`)
    .join("");
  const stockoutLines =
    inventory.newStockouts.length > 0
      ? inventory.newStockouts.map((n) => `<li>${esc(n)}</li>`).join("")
      : `<li>${noDataLabel}</li>`;
  const priceMoveLines =
    inventory.priceMoves.length > 0
      ? inventory.priceMoves.map((p) => `<li>${esc(p.name)}: ${p.from} → ${p.to}</li>`).join("")
      : `<li>${noDataLabel}</li>`;
  const newAdLines =
    ads.new.length > 0
      ? ads.new
          .map(
            (a) =>
              `<li>${esc(a.adTitle ?? noDataLabel)}${a.daysRunning != null ? ` (${a.daysRunning} ${isEn ? "days" : "дена"})` : ""}</li>`,
          )
          .join("")
      : `<li>${noDataLabel}</li>`;

  return `
<h3>${esc(c.targetId)}</h3>
<h4>${salesLabel}</h4>
<ul>
  <li>${onSaleLabel}: ${sales.onSaleToday}</li>
  <li>${avgPctLabel}: ${avgPctStr}</li>
  <li>${newlyDiscLabel}: ${sales.newlyDiscounted}</li>
  <li>${endedLabel}: ${sales.ended}</li>
</ul>
<h4>${adsLabel}</h4>
<ul>
  <li>${activeTodayLabel}: ${ads.activeToday}</li>
  <li>${newAdsLabel}: <ul>${newAdLines}</ul></li>
  <li>${longestLabel}: ${longestRunningStr}</li>
</ul>
<h4>${socialLabel}</h4>
<ul>
  <li>${followerDeltaLabel}: <ul>${followerLines || `<li>${noDataLabel}</li>`}</ul></li>
</ul>
<h4>${inventoryLabel}</h4>
<ul>
  <li>${newProductsLabel}: ${inventory.newProducts}</li>
  <li>${stockoutsLabel}: <ul>${stockoutLines}</ul></li>
  <li>${priceMovesLabel}: <ul>${priceMoveLines}</ul></li>
</ul>`;
}

/** Deterministic bilingual fallback (EN then MK) used when Gemini is unavailable. */
export function templateDigest(digest: DigestResult): string {
  const block = (lang: "en" | "mk") => {
    const heading = lang === "en" ? "Daily competitor digest" : "Дневен преглед на конкуренти";
    const dateLabel = lang === "en" ? "Date" : "Датум";
    const blocks = digest.competitors.map((c) => competitorBlock(c, lang)).join("\n<hr/>\n");
    return `<h2>${heading}</h2>
<p>${dateLabel}: <strong>${esc(digest.generatedFor)}</strong></p>
${blocks}`;
  };
  return `${block("en")}
<hr/>
${block("mk")}`;
}

/** Call Gemini with the given prompt as the system instruction. Returns null on any failure. */
export async function geminiNarrate(
  digest: DigestResult,
  promptBody: string,
  model = MODEL,
): Promise<string | null> {
  const key = optionalEnv("GEMINI_API_KEY");
  if (!key) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: promptBody }] },
        contents: [{ parts: [{ text: JSON.stringify(digest) }] }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;
    return text.replace(/```[\w]*\n?/g, "").trim();
  } catch {
    return null;
  }
}

function emailShell(subject: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(subject)}</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 16px; }
    h2 { color: #1a1a2e; border-bottom: 2px solid #e94560; padding-bottom: 4px; }
    h3 { color: #16213e; }
    h4 { color: #0f3460; margin-bottom: 4px; }
    ul { margin-top: 2px; }
    hr { border: none; border-top: 1px solid #ccc; margin: 32px 0; }
  </style>
</head>
<body>
<h1>${esc(subject)}</h1>
${inner}
</body>
</html>`;
}

/** Render the digest email from a prompt; falls back to the template if Gemini is unavailable. */
export async function renderDigestWithPrompt(
  digest: DigestResult,
  promptBody: string,
): Promise<{ subject: string; html: string; usedFallback: boolean }> {
  const subject = `MY:TIME — Дневен преглед / Daily digest (${digest.generatedFor})`;
  const narrated = await geminiNarrate(digest, promptBody);
  const usedFallback = narrated == null;
  const inner = narrated ?? templateDigest(digest);
  return { subject, html: emailShell(subject, inner), usedFallback };
}
