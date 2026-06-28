# Deploy & operations

Daily ingestion runs as a **systemd oneshot service** triggered by a **timer**.
The runner executes every collector with per-source failure isolation (one
source failing logs and continues) and records each run in the `ingestion_runs`
table. Full provisioning (VPS, Caddy, TLS, MCP server) is Phase 6 — this covers
the ingestion scheduler.

## Prerequisites (on the VPS)

- Node.js 20+ and `pnpm` (via `corepack enable`).
- Repo at `/opt/mytime-bi` (adjust paths in the unit files if different).
- A non-root service user: `useradd --system --home /opt/mytime-bi mytime`.
- `/opt/mytime-bi/.env` filled in (see `.env.example`) and owned by `mytime`,
  `chmod 600`. **For production set the SSL CA** (`DATABASE_CA_CERT`) instead of
  `DATABASE_SSL_NO_VERIFY`.

## Build & migrate

```bash
cd /opt/mytime-bi
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate      # apply schema (idempotent)
pnpm db:seed         # load targets/locations/social accounts from config
```

## Install the scheduler

```bash
sudo cp deploy/systemd/mytime-ingest.service /etc/systemd/system/
sudo cp deploy/systemd/mytime-ingest.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mytime-ingest.timer
```

Confirm it's scheduled:

```bash
systemctl list-timers mytime-ingest.timer
```

## Run manually / on demand

```bash
sudo systemctl start mytime-ingest.service     # trigger a full run now
# or, as the service user, directly:
pnpm ingest
```

Targeted runs (e.g. re-run one collector or target) via env filters:

```bash
INGEST_COLLECTORS=woocommerce-store-api INGEST_TARGETS=b-watch pnpm ingest
WEB_MAX_PRODUCTS=100000 INGEST_COLLECTORS=web-jsonld pnpm ingest
```

## Observability

```bash
# Live logs (structured JSON via pino → journald)
journalctl -u mytime-ingest.service -f
# Last run's exit status / timing
systemctl status mytime-ingest.service
# Run summary from the database (per collector, last 2 days)
pnpm ingest:status
```

Each collector writes a `success` / `failed` row to `ingestion_runs` with
`rows_written` and any `error`, so a failed source is visible without scraping
logs.

## Change the schedule or scope

- **Time:** edit `OnCalendar=` in `mytime-ingest.timer` (keep the VPS clock UTC),
  then `systemctl daemon-reload && systemctl restart mytime-ingest.timer`.
- **Catalog size:** the service sets `WEB_MAX_PRODUCTS=100000` (full catalogs).
  Lower it to throttle.
- **Apify cost:** the social collectors call paid Apify actors. On a small plan,
  consider scheduling social less often than the web crawl (e.g. a second timer
  with `INGEST_COLLECTORS=apify-instagram,apify-facebook,apify-tiktok`).

## Cron alternative

If you prefer cron over systemd:

```cron
# /etc/cron.d/mytime-ingest  (UTC)
15 3 * * *  mytime  cd /opt/mytime-bi && NODE_ENV=production WEB_MAX_PRODUCTS=100000 /usr/bin/node ingestion/dist/index.js >> /var/log/mytime-ingest.log 2>&1
```
