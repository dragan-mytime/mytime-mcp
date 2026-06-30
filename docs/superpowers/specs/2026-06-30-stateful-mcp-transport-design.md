# Stateful Streamable-HTTP MCP transport (live tool refresh)

**Date:** 2026-06-30
**Status:** Approved (build)
**Area:** `mcp-server/src/server.ts` — the `/mcp` request path.

## Problem

Newly deployed MCP tools don't appear in a connected client until the user manually
disconnects/reconnects the connector. Cause: `/mcp` runs the Streamable-HTTP transport in
**stateless** mode (`sessionIdGenerator: undefined`, a fresh transport per POST, no `GET /mcp` SSE
stream). MCP clients fetch `tools/list` once and cache it; the spec's refresh mechanism is a
server→client `notifications/tools/list_changed` push, which requires a persistent session + SSE
stream. Stateless mode has neither, so the cached list never refreshes on its own.

## Solution

Run the transport in **stateful** mode with session management (the SDK's documented pattern,
@modelcontextprotocol/sdk 1.29.0):

- Keep a `Map<sessionId, StreamableHTTPServerTransport>`.
- **`POST /mcp`**: if the request carries a known `mcp-session-id`, reuse that transport; if it's an
  `initialize` request with no session, create a new stateful transport (`sessionIdGenerator:
  randomUUID`, `onsessioninitialized` registers it in the map), build + connect a fresh
  `McpServer`, and set `transport.onclose` to evict the session; otherwise 400.
- **`GET /mcp`**: open the SSE stream for an existing session (the channel the server pushes
  notifications over). 404 for unknown sessions.
- **`DELETE /mcp`**: terminate a session (evict + close).
- All three keep `requireBearerAuth` (JWT verify is stateless — unaffected).

**Why this fixes it:** on a deploy/restart the server loses all in-memory sessions; the client's
next request presents a now-unknown `mcp-session-id` → the transport replies **404**, which per the
Streamable-HTTP spec makes the client re-`initialize` a fresh session → it re-runs `tools/list` and
**sees the new tool automatically** — no manual toggle. The persistent SSE stream additionally lets
the server emit `tools/list_changed` for any in-session change (`McpServer` advertises
`tools.listChanged` and calls it when a tool is enabled/disabled/removed/registered dynamically).

## Decisions / scope

- **In-memory sessions** (per the SDK default). Sessions are ephemeral; a restart wiping them is
  exactly what triggers the desired client re-init. No persistence, no `eventStore`/resumability in
  v1 (YAGNI).
- One `McpServer` per session (built on init), closed on session close — replaces the
  per-POST build. Tool set is identical (registered from the same `tools` array).
- A deploy still briefly drops the live connection; the client auto-reconnects (no re-auth — OAuth
  state is already persisted) and re-lists. The win is **no manual reconnect** + tools appear on
  their own.
- No change to tools, auth, or any other route.

## Testing

- Build + existing mcp-server tests + Biome clean.
- **Live verification (no OAuth UI needed):** mint a valid access token with `issueAccessToken`
  (signed with `MCP_JWT_SECRET` from `.env`), then over HTTP to the running server:
  1. `POST /mcp` `initialize` → expect 200 + an `mcp-session-id` response header.
  2. `POST /mcp` `tools/list` with that session id → expect the tool list **including
     `compare_skus`**.
  3. `POST /mcp` `tools/list` with a bogus session id → expect **404** (proves stale sessions are
     rejected, which is what drives the client re-init after a deploy).
  4. `DELETE /mcp` with the session id → session evicted.
- Confirm the real Claude connector still works after deploy (it reconnects without a manual toggle
  and shows current tools).

## Success criteria

1. `/mcp` is stateful: initialize returns a session id; subsequent calls reuse it; unknown session
   ids 404; sessions evict on close.
2. After a deploy/restart, a previously-connected client re-initializes on its next call and sees
   the current tool set without a manual reconnect.
3. Build + tests + Biome clean; no regression to auth or existing tools.
