# Phase 5 — Google OAuth client (manual setup)

The MCP server uses **Google** as the upstream login. You create one OAuth
client; I wire the rest (domain gate + allowlist + roles). ~5 minutes.

## Steps

1. **Google Cloud Console** → console.cloud.google.com → pick/create a project
   (e.g. "MY:TIME BI").
2. **APIs & Services → OAuth consent screen**:
   - If `mytime.mk` is a **Google Workspace** domain, choose **User type =
     Internal**. This means only `@mytime.mk` accounts can even log in — a nice
     reinforcement of our domain gate. (If it's not Workspace, choose External
     and add yourself as a test user.)
   - Scopes: just the default **`openid`, `email`, `profile`** (non-sensitive —
     no Google verification needed).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: "MY:TIME MCP".
   - **Authorized redirect URIs** — add both:
     - `https://mcp.mytimeprime.mk/auth/google/callback`  (production)
     - `http://localhost:8080/auth/google/callback`  (local testing)
   - Create → copy the **Client ID** and **Client secret**.

## Put in `.env`

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
MCP_PUBLIC_URL=https://mcp.mytimeprime.mk     # already set; use http://localhost:8080 for local tests
ALLOWED_EMAIL_DOMAIN=mytime.mk       # already set
# MCP_JWT_SECRET is generated automatically (see below) — keep it secret & stable.
```

## How access is decided (so you know what to expect)

1. **Domain gate (Layer 1):** Google must return a **verified** email on the
   **`mytime.mk`** domain. Anything else is rejected — even a valid Google
   account on another domain.
2. **Whitelist + role (Layer 2):** your email must have an **active** row in the
   `authorized_users` Supabase table. No row / `active=false` = no access, even
   with a valid `@mytime.mk` login.

You manage users in the **Supabase table editor** (`authorized_users`: `email`,
`role` ∈ admin/analyst/viewer, `active`) — no redeploy. I've seeded
`dragan@mytime.mk` as **admin** so you're not locked out.

When you've created the client, drop `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
into `.env` and I'll run the end-to-end test.
