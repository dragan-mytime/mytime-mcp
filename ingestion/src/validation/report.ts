import { mkdirSync, writeFileSync } from "node:fs";
import type { ProductResult } from "./types.js";

export function writeReport(
  results: ProductResult[],
  dateIso: string,
): { md: string; json: string } {
  mkdirSync("docs/validation", { recursive: true });
  const md = `docs/validation/${dateIso}-validation.md`;
  const json = `docs/validation/${dateIso}-validation.json`;

  const byTarget = new Map<string, ProductResult[]>();
  for (const r of results) {
    let bucket = byTarget.get(r.targetId);
    if (!bucket) {
      bucket = [];
      byTarget.set(r.targetId, bucket);
    }
    bucket.push(r);
  }

  let out = `# Validation report — ${dateIso}\n\n`;
  for (const [t, rs] of byTarget) {
    const errs = rs.flatMap((r) => r.dataMismatches.filter((m) => m.severity === "error"));
    const drift = rs.flatMap((r) => r.driftFlags);
    out += `## ${t} — ${rs.length} sampled, ${errs.length} data errors, ${drift.length} drift flags\n\n`;
    for (const r of rs) {
      const e = r.dataMismatches.filter((m) => m.severity === "error");
      if (!e.length && !r.driftFlags.length) continue;
      out += `- ${r.externalId} <${r.url}>\n`;
      for (const m of e)
        out += `  - **${m.field}** db=${JSON.stringify(m.dbValue)} live=${JSON.stringify(m.liveValue)}${m.note ? ` (${m.note})` : ""}\n`;
      for (const m of r.driftFlags)
        out += `  - _drift_ ${m.field}: verifier=${JSON.stringify(m.dbValue)} llm=${JSON.stringify(m.liveValue)}\n`;
    }
    out += "\n";
  }
  writeFileSync(md, out);
  writeFileSync(json, JSON.stringify(results, null, 2));
  return { md, json };
}
