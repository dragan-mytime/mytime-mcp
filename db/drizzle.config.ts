import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Consumed directly by drizzle-kit (not part of the tsc build). Phase 2 runs
// `pnpm db:generate` / `pnpm db:migrate` against Supabase using DATABASE_URL.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
