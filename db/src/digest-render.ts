import { optionalEnv } from "@mytime/shared";
import type { CompetitorDigest, DigestResult, FreshnessInfo } from "./digest.js";

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
  const undercutsLabel = isEn ? "Price undercuts" : "Пониски цени од нашите";
  const newlyUndercutLabel = isEn ? "Newly undercut" : "Ново подбиени";
  const resolvedLabel = isEn ? "Resolved" : "Разрешени";
  const noDataLabel = isEn ? "none" : "нема";

  // E3: a stale collector family means zeros are "no fresh data", not inactivity.
  const staleLine = (f: FreshnessInfo) => {
    const since = f.lastSuccessAt ? f.lastSuccessAt.slice(0, 10) : isEn ? "unknown" : "непознато";
    const label = isEn ? `⚠ no fresh data since ${since}` : `⚠ нема свежи податоци од ${since}`;
    return `<ul><li>${esc(label)}</li></ul>`;
  };
  const freshness = c.dataFreshness;

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

  const salesBlock = freshness.products.stale
    ? staleLine(freshness.products)
    : `<ul>
  <li>${onSaleLabel}: ${sales.onSaleToday}</li>
  <li>${avgPctLabel}: ${avgPctStr}</li>
  <li>${newlyDiscLabel}: ${sales.newlyDiscounted}</li>
  <li>${endedLabel}: ${sales.ended}</li>
</ul>`;
  const adsBlock = freshness.ads.stale
    ? staleLine(freshness.ads)
    : `<ul>
  <li>${activeTodayLabel}: ${ads.activeToday}</li>
  <li>${newAdsLabel}: <ul>${newAdLines}</ul></li>
  <li>${longestLabel}: ${longestRunningStr}</li>
</ul>`;
  const socialBlock = freshness.social.stale
    ? staleLine(freshness.social)
    : `<ul>
  <li>${followerDeltaLabel}: <ul>${followerLines || `<li>${noDataLabel}</li>`}</ul></li>
</ul>`;
  const inventoryBlock = freshness.products.stale
    ? staleLine(freshness.products)
    : `<ul>
  <li>${newProductsLabel}: ${inventory.newProducts}</li>
  <li>${stockoutsLabel}: <ul>${stockoutLines}</ul></li>
  <li>${priceMovesLabel}: <ul>${priceMoveLines}</ul></li>
</ul>`;

  // E2: price undercuts — derived from prices, so it shares the products
  // freshness gate. Optional-chained for digests serialized before the field existed.
  const undercuts = c.priceUndercuts;
  const undercutItem = (u: {
    ref: string;
    name: string;
    mtPrice: number;
    compPrice: number;
    deltaPct: number | null;
  }) =>
    `<li>${esc(u.name)} (${esc(u.ref)}): ${isEn ? "us" : "ние"} ${u.mtPrice} ${isEn ? "vs" : "нс."} ${u.compPrice}${u.deltaPct != null ? ` (${u.deltaPct}%)` : ""}</li>`;
  const newlyUndercutLines =
    undercuts && undercuts.newlyUndercut.length > 0
      ? undercuts.newlyUndercut.map(undercutItem).join("")
      : `<li>${noDataLabel}</li>`;
  const resolvedLines =
    undercuts && undercuts.resolved.length > 0
      ? undercuts.resolved.map(undercutItem).join("")
      : `<li>${noDataLabel}</li>`;
  const undercutsBlock = freshness.products.stale
    ? staleLine(freshness.products)
    : `<ul>
  <li>${newlyUndercutLabel}: ${undercuts?.totalNewlyUndercut ?? 0} <ul>${newlyUndercutLines}</ul></li>
  <li>${resolvedLabel}: ${undercuts?.totalResolved ?? 0} <ul>${resolvedLines}</ul></li>
</ul>`;

  return `
<h3>${esc(c.targetId)}</h3>
<h4>${salesLabel}</h4>
${salesBlock}
<h4>${adsLabel}</h4>
${adsBlock}
<h4>${socialLabel}</h4>
${socialBlock}
<h4>${inventoryLabel}</h4>
${inventoryBlock}
<h4>${undercutsLabel}</h4>
${undercutsBlock}`;
}

/** Deterministic bilingual fallback (EN then MK) used when Gemini is unavailable. */
export function templateDigest(digest: DigestResult): string {
  const weekly = digest.windowDays > 1;
  const block = (lang: "en" | "mk") => {
    const heading =
      lang === "en"
        ? weekly
          ? `Weekly competitor digest (${digest.windowDays}-day window)`
          : "Daily competitor digest"
        : weekly
          ? `Неделен преглед на конкуренти (${digest.windowDays} дена)`
          : "Дневен преглед на конкуренти";
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

/**
 * Call Gemini with the given prompt as the system instruction. Returns null on any failure.
 * `apiKey` (when provided) overrides the `GEMINI_API_KEY` env var — lets the key come from the
 * DB-backed setting. Falls back to env when `apiKey` is omitted.
 */
export async function geminiNarrate(
  digest: DigestResult,
  promptBody: string,
  apiKey?: string,
  model = MODEL,
): Promise<string | null> {
  const key = apiKey ?? optionalEnv("GEMINI_API_KEY");
  if (!key) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: promptBody }] },
        contents: [{ parts: [{ text: JSON.stringify(digest) }] }],
        // gemini-2.5-flash is a thinking model: "thinking" spends output tokens
        // before the answer, so a long prompt could exhaust a small budget on
        // reasoning and return an empty/truncated body. Disable thinking and give
        // the HTML email room (a full digest runs ~25k chars ≈ 8k tokens).
        generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
      }),
      // A full bilingual digest is ~8k output tokens, which can take 40-60s to
      // generate; 30s was too short and forced the template fallback.
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    // Strip code fences; treat empty-after-strip as a failure so the caller falls
    // back to the deterministic template instead of rendering a blank body.
    const stripped = text.replace(/```[\w]*\n?/g, "").trim();
    return stripped || null;
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
  apiKey?: string,
): Promise<{ subject: string; html: string; usedFallback: boolean }> {
  const subject =
    digest.windowDays > 1
      ? `MY:TIME — Неделен преглед / Weekly digest (${digest.generatedFor})`
      : `MY:TIME — Дневен преглед / Daily digest (${digest.generatedFor})`;
  const narrated = await geminiNarrate(digest, promptBody, apiKey);
  const usedFallback = narrated == null;
  const inner = narrated ?? templateDigest(digest);
  return { subject, html: emailShell(subject, inner), usedFallback };
}
