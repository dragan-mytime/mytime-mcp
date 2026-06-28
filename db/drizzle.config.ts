import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Workspace scripts run with the db package dir as cwd; load the repo-root .env.
config({ path: ["../.env", ".env"] });

// Consumed directly by drizzle-kit (not part of the tsc build). Phase 2 runs
// `pnpm db:generate` / `pnpm db:migrate` against Supabase using DATABASE_URL.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
    ssl: process.env.DATABASE_SSL_NO_VERIFY === "true" ? { rejectUnauthorized: false } : true,
  },
  strict: true,
  verbose: true,
});
