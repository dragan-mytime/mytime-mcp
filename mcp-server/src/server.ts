import { logger } from "@mytime/shared";
import { health } from "./health.js";
import { tools } from "./tools/index.js";

/**
 * Phase 0 scaffold. Describes what the server WILL expose so the wiring is
 * visible and testable now.
 *
 * Phase 4: stand up the Streamable HTTP transport with the MCP TypeScript SDK
 *          and register `tools` (callable locally via MCP Inspector, no auth).
 * Phase 5: wrap with OAuth 2.1 (PKCE/S256 + Dynamic Client Registration +
 *          Protected Resource Metadata) and the two-layer Google domain gate +
 *          authorized_users role middleware.
 * Phase 6: deploy behind Caddy at https://mcp.my.mk.
 */
export function describeServer() {
  return {
    health: health(),
    tools: tools.map((t) => ({ name: t.name, requiredRole: t.requiredRole })),
  };
}

export { health, tools };

logger.info(describeServer(), "mcp-server scaffold ready (transport added in Phase 4)");
