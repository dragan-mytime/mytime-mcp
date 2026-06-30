# Stateful MCP Transport Implementation Plan

> **For agentic workers:** single-file change to `mcp-server/src/server.ts`. Execute inline.

**Goal:** Run `/mcp` in stateful Streamable-HTTP mode with session management so deployed tool changes appear in connected clients without a manual reconnect.

**Spec:** `docs/superpowers/specs/2026-06-30-stateful-mcp-transport-design.md`

---

### Task 1 — Stateful `/mcp` (session map + GET/DELETE)

**File:** `mcp-server/src/server.ts`

- [ ] **Step 1 — imports.** Add at top: `import { randomUUID } from "node:crypto";` and add `isInitializeRequest` to the SDK types import (`import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";`).

- [ ] **Step 2 — replace the stateless `app.post("/mcp", …)` block** with a session-managed POST + GET + DELETE. Inside `createApp`, before the POST, add the session map:

```ts
  // Stateful Streamable-HTTP sessions so tool-list changes reach clients without a
  // manual reconnect: after a deploy the in-memory sessions are gone, the client's
  // next call 404s, and it re-initializes → re-lists tools (sees new tools on its own).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(
    "/mcp",
    express.json(),
    requireBearerAuth({ verifier: provider, resourceMetadataUrl }),
    async (req, res) => {
      const sid = req.header("mcp-session-id");
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        if (sid || !isInitializeRequest(req.body)) {
          res
            .status(sid ? 404 : 400)
            .json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport as StreamableHTTPServerTransport);
          },
        });
        const server = buildMcpServer();
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
          server.close();
        };
        await server.connect(transport);
      }
      try {
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        logger.error({ err }, "MCP request failed");
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      }
    },
  );

  // SSE stream (server→client notifications, incl. tools/list_changed) + session teardown.
  const sessionRequest = async (req: express.Request, res: express.Response): Promise<void> => {
    const sid = req.header("mcp-session-id");
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(404).end();
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", requireBearerAuth({ verifier: provider, resourceMetadataUrl }), sessionRequest);
  app.delete("/mcp", requireBearerAuth({ verifier: provider, resourceMetadataUrl }), sessionRequest);
```

(Remove the old per-POST `buildMcpServer()` + `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` block entirely — it is replaced above. Keep everything else in `createApp` unchanged.)

- [ ] **Step 3 — build:** `pnpm --filter @mytime/mcp-server build` (exit 0).
- [ ] **Step 4 — tests + Biome:** `pnpm --filter @mytime/mcp-server test` (10 pass), `pnpm exec biome check --write mcp-server/src/server.ts` then recheck clean.
- [ ] **Step 5 — commit.**

---

### Task 2 — Deploy + live verify

- [ ] Deploy the branch (`git archive HEAD | ssh …`, Node-24 build), restart `mytime-mcp`.
- [ ] Mint a token with `issueAccessToken` (MCP_JWT_SECRET from `.env`) and over HTTP to `http://127.0.0.1:8080/mcp`:
  1. `initialize` (POST, `Accept: application/json, text/event-stream`) → 200 + `mcp-session-id` header.
  2. `tools/list` (POST, with that session id) → list **includes `compare_skus`**.
  3. `tools/list` with a bogus session id → **404**.
- [ ] Merge to `main`, push, deploy.

---

## Self-Review
- Spec coverage: stateful POST + session map → T1; GET/DELETE SSE+teardown → T1; bearer auth on all three → T1; 404-on-stale → T1; live verify (init/list/404) → T2. ✅
- No placeholders; the one block is complete and self-contained.
- Type consistency: `transports: Map<string, StreamableHTTPServerTransport>`; `transport.sessionId`/`onclose` per SDK 1.29.0; `isInitializeRequest(req.body)`. ✅
