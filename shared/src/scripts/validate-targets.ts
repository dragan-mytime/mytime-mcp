import { resolve } from "node:path";
import { loadTargets, webTrackableTargets } from "../targets.js";

// CLI: validate config/targets.json and print a coverage summary.
// Usage: node shared/dist/scripts/validate-targets.js [path]
const path = resolve(process.argv[2] ?? "config/targets.json");

try {
  const targets = loadTargets(path);
  const web = webTrackableTargets(targets);
  const social = targets.filter((t) => Object.keys(t.social).length > 0);

  console.log(`✓ ${path} is valid.`);
  console.log(`  targets:            ${targets.length}`);
  console.log(`  web-trackable:      ${web.length} (${web.map((t) => t.id).join(", ")})`);
  console.log(`  with social:        ${social.length}`);
  console.log(
    `  monobrand:          ${
      targets
        .filter((t) => t.web.enabled && t.web.monobrand)
        .map((t) => t.id)
        .join(", ") || "none"
    }`,
  );
  console.log(
    `  social-only (no web): ${
      targets
        .filter((t) => !t.web.enabled)
        .map((t) => t.id)
        .join(", ") || "none"
    }`,
  );
  process.exit(0);
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exit(1);
}
