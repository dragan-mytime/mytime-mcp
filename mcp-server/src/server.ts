import { fileURLToPath } from "node:url";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger, optionalEnv, type Role, requireEnv } from "@mytime/shared";
import express from "express";
import { createMyTimeProvider, handleGoogleCallback } from "./auth/provider.js";
import { roleSatisfies } from "./auth/roles.js";
import { readPool } from "./db.js";
import { health } from "./health.js";
import { tools } from "./tools/index.js";

/**
 * Build an MCP server instance with all tools registered. Per-tool role gating
 * uses the AuthInfo populated by `requireBearerAuth` (role from our JWT).
 */
export function buildMcpServer(): McpServer {
  // Advertise brand identity + icon so icon-aware clients (e.g. Claude) can
  // render the MY:TIME logo for the connector. The icon is served from this
  // server's own domain (see /icon.png), satisfying the spec's same-origin rule.
  const iconUrl = new URL("/icon.png", requireEnv("MCP_PUBLIC_URL")).toString();
  const server = new McpServer({
    name: "mytime-mcp",
    title: "MY:TIME Competitive Intelligence",
    version: "1.0.0",
    websiteUrl: "https://www.mytime.mk",
    icons: [{ src: iconUrl, mimeType: "image/png", sizes: ["512x512"] }],
  });
  const pool = readPool();
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema },
      async (
        args: Record<string, unknown>,
        extra: { authInfo?: { extra?: Record<string, unknown> } },
      ) => {
        const role = extra.authInfo?.extra?.role as Role | undefined;
        if (!role || !roleSatisfies(role, t.requiredRole)) {
          throw new Error(`forbidden: tool '${t.name}' requires role '${t.requiredRole}'`);
        }
        const data = await t.run(pool, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      },
    );
  }
  return server;
}

/** Express app: OAuth 2.1 endpoints + Google callback + protected /mcp + /health. */
export function createApp(): express.Express {
  const app = express();
  const pool = readPool();
  const provider = createMyTimeProvider(pool);
  const issuerUrl = new URL(requireEnv("MCP_PUBLIC_URL"));
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(issuerUrl);

  app.get("/health", (_req, res) => res.json(health()));

  // Public brand icon advertised in serverInfo.icons (no auth — clients fetch it directly).
  const iconPath = fileURLToPath(new URL("../assets/mcp-icon.png", import.meta.url));
  app.get("/icon.png", (_req, res) => {
    res.type("image/png").set("Cache-Control", "public, max-age=86400").sendFile(iconPath);
  });

  // Upstream Google callback → two-layer gate → mint our auth code.
  app.get("/auth/google/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    if (!code || !state) {
      res.status(400).send("Missing code/state");
      return;
    }
    try {
      res.redirect(await handleGoogleCallback(pool, code, state));
    } catch (err) {
      logger.error({ err }, "google callback failed");
      res.status(400).send("Authorization failed or expired. Please retry the login.");
    }
  });

  // OAuth 2.1 Authorization Server: /authorize, /token, /register, metadata
  // (PKCE S256, Dynamic Client Registration, Protected Resource Metadata).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: ["read", "write", "admin"],
      resourceName: "MY:TIME Competitive Intelligence",
    }),
  );

  // Protected MCP endpoint — 401 + WWW-Authenticate → resource metadata when unauthenticated.
  app.post(
    "/mcp",
    express.json(),
    requireBearerAuth({ verifier: provider, resourceMetadataUrl }),
    async (req, res) => {
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
    },
  );

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(optionalEnv("MCP_PORT", "8080"));
  createApp().listen(port, () => {
    logger.info(
      { port, tools: tools.map((t) => t.name) },
      "MCP server listening (OAuth 2.1 enabled)",
    );
  });
}
