import { pino } from "pino";
import { optionalEnv } from "./env.js";

/** Shared structured logger. Level via LOG_LEVEL (default "info"). */
export const logger = pino({
  level: optionalEnv("LOG_LEVEL", "info"),
  base: { service: "mytime-bi" },
});

export type Logger = typeof logger;
