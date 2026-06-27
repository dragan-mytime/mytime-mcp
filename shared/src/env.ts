import { config as loadDotenv } from "dotenv";

// Load .env once at import time. Safe to call repeatedly; dotenv won't override
// variables that are already set in the real environment (e.g. on the VPS).
loadDotenv();

/**
 * Read a required environment variable, failing fast with a clear message that
 * names the missing variable (per the build brief, §5).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example for the full list.`,
    );
  }
  return value;
}

/** Read an optional environment variable, returning `fallback` when unset/empty. */
export function optionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}
