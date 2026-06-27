import type { Role } from "@mytime/shared";

/**
 * An MCP tool definition. The `requiredRole` is declared in metadata so the
 * Phase 5 auth middleware can enforce roles generically — the tool handler
 * itself never re-implements authorization.
 *
 * Each tool reads ONLY from Postgres (read-mostly DB role).
 */
export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  /** Minimum role allowed to call this tool: admin > analyst > viewer. */
  readonly requiredRole: Role;
  /** JSON-schema-ish input shape; Phase 4 binds this to the MCP SDK. */
  readonly inputSchema?: unknown;
  handler(input: Input): Promise<Output>;
}
