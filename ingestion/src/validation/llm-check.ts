import { optionalEnv } from "@mytime/shared";
import type { LiveSnapshot } from "./types.js";

const MODEL = "gemini-2.5-flash";
const SYS =
  "Extract product facts from the page markdown as STRICT JSON with keys " +
  "name, brand, price (number, regular/list price), salePrice (number or null, " +
  "the discounted price if shown), stockStatus (one of in_stock,out_of_stock,low_stock,unknown). " +
  "Prices are Macedonian denar; return plain numbers. Output JSON only.";

/** Independent LLM read of the page — used ONLY as a drift signal, never as truth. */
export async function llmExtract(markdown: string): Promise<LiveSnapshot | null> {
  const key = optionalEnv("GEMINI_API_KEY");
  if (!key) return null; // drift check is optional; skip cleanly when unconfigured
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYS }] },
      contents: [{ parts: [{ text: markdown.slice(0, 12_000) }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 400 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as LiveSnapshot;
  } catch {
    return null;
  }
}
