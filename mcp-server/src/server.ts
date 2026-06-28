import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger, optionalEnv } from "@mytime/shared";
import express from "express";
import { readPool } from "./db.js";
import { health } from "./health.js";
import { tools } from "./tools/index.js";

/**
 * Build an MCP server instance with all tools registered. Phase 4: callable
 * locally with no auth (MCP Inspector / HTTP). Phase 5 wraps the HTTP layer with
 * OAuth 2.1 + the per-tool role gate (each tool's requiredRole is in the registry).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "mytime-mcp", version: "1.0.0" });
  const pool = readPool();
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema },
      async (args: Record<string, unknown>) => {
        const data = await t.run(pool, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      },
    );
  }
  return server;
}

/** Express app exposing the Streamable HTTP MCP endpoint + /health. */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json(health()));

  // Stateless Streamable HTTP: a fresh server + transport per request.
  app.post("/mcp", async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "MCP request failed");
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(optionalEnv("MCP_PORT", "8080"));
  createApp().listen(port, () => {
    logger.info({ port, tools: tools.map((t) => t.name) }, "MCP server listening");
  });
}
