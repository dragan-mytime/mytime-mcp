import type { Pool, Role } from "@mytime/shared";
import type { ZodRawShape } from "zod";

/**
 * An MCP tool definition. `requiredRole` is kept in this registry (not in the
 * MCP wire format) so the Phase 5 auth middleware can enforce it per tool by
 * name. Each tool reads only from Postgres.
 */
export interface McpToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Minimum role to call this tool: admin > analyst > viewer. */
  readonly requiredRole: Role;
  /** Zod raw shape for input validation (SDK registerTool form). */
  readonly inputSchema: ZodRawShape;
  run(pool: Pool, args: Record<string, unknown>): Promise<unknown>;
}
