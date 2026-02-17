# WoW Auction Optimizer

Cloud-native web app that identifies high-demand, high-price World of Warcraft auction house items across all connected realms.

- **Hot Items Radar**: Sorted by "hotness" -- items with above-average demand AND price
- **Demand Proxy**: Snapshot churn (EWMA-smoothed) since Blizzard does not expose completed sales
- **Cross-Realm**: Recommends the best realm to sell each item on
- **Precomputed**: Background jobs crunch the data; UI serves instantly

## Architecture

```
┌─ AWS Amplify ──────────────────────┐
│  Next.js App                       │
│  ├── Frontend (React pages)        │
│  └── API Route Handlers            │
│       ├── AWS RDS (PostgreSQL)     │
│       └── Upstash Redis (cache)    │
└────────────────────────────────────┘
         ▲
         │  GitHub Actions (hourly)
         ├── ingest.py
         ├── compute.py
         ├── cleanup.py
         └── meta_resolve.py
```

## Quick Start (Local Dev)

### Prerequisites
- **Python 3.11+** with pip
- **Node.js 18+** with npm
- **PostgreSQL 14+** (local install, AWS RDS, or Docker)

### 1. Setup
```bash
cp .env.example .env
# Fill in: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET, DATABASE_URL
```

### 2. Database
```bash
# Option A: Local Postgres
createdb wow_auction
psql -d wow_auction -f migrations/001_initial.sql

# Option B: Docker (just the database)
docker-compose up -d postgres

# Option C: AWS RDS (create instance, use connection string)
```

### 3. Install & Run Backend Jobs
```bash
pip install -r requirements.txt

python -m services.jobs.ingest      # Fetch auction data (~5-15 min)
python -m services.jobs.compute     # Compute features (~1-3 min)
python -m services.jobs.meta_resolve  # Resolve item names/icons
```

### 4. Run Frontend
```bash
cd apps/web
npm install
npm run dev
# Open http://localhost:3000
```

> **Note**: For local dev, the `postgres` npm package reads `DATABASE_URL` from `.env`. It accepts `postgresql+asyncpg://` format (strips the driver suffix automatically).

---

## Deploy to AWS Amplify

| Service | Provider | Plan |
|---------|----------|------|
| Frontend + API | **AWS Amplify** | Free tier |
| Database | **AWS RDS** (PostgreSQL) | Free tier eligible |
| Cache | [Upstash](https://upstash.com) Redis | Free (10K req/day) |
| Background Jobs | **GitHub Actions** | Free (private repos: 2K min/mo) |

### Steps

1. **RDS Database**: Create a PostgreSQL instance in AWS RDS → note the connection string.

2. **Amplify Deploy**:
   - Connect your GitHub repo to Amplify
   - `amplify.yml` is already configured (base: `apps/web`)
   - Add environment variables in Amplify console:
     - `DATABASE_URL` = your RDS connection string (`postgresql://` format)
     - `REGION` = `us` (or `eu`)
     - `UPSTASH_REDIS_REST_URL` = your Upstash REST URL
     - `UPSTASH_REDIS_REST_TOKEN` = your Upstash REST token

3. **Initialize Database**: Run the migration against your RDS instance:
   ```bash
   psql "your-rds-connection-string" -f migrations/001_initial.sql
   ```

4. **GitHub Actions Secrets**: In your repo settings, add:
   - `DATABASE_URL` (async format: `postgresql+asyncpg://...`)
   - `DATABASE_URL_SYNC` (standard format: `postgresql://...`)
   - `BLIZZARD_CLIENT_ID`
   - `BLIZZARD_CLIENT_SECRET`
   - `REDIS_URL` (optional, from Upstash)

5. **Trigger First Run**: Manually trigger the GitHub Actions workflow, or wait for the hourly cron.

### GitHub Actions Workflow

Already configured in `.github/workflows/jobs.yml`. Runs hourly:
1. Cleanup old data (snapshots > 30 days)
2. Ingest auction data from Blizzard API
3. Compute hotness/features
4. Resolve item metadata

---

## Project Structure

```
wow-auction-optimizer/
├── apps/web/                  Next.js (frontend + API routes)
│   └── src/app/api/           API Route Handlers (query RDS directly)
│   └── src/lib/cache.ts       Upstash Redis cache layer
├── services/jobs/             Python background jobs
├── packages/shared/           Shared Python (Blizzard client, models)
├── migrations/                SQL schema
├── infra/terraform/           GCP IaC (optional)
├── docs/                      Architecture, ADRs, operations
├── .agent/workflows/          Agent workflow files
├── .github/workflows/         GitHub Actions
├── amplify.yml                AWS Amplify build config
├── docker-compose.yml         Local Postgres + Redis (optional)
└── requirements.txt           Python deps
```

## Key Design Decisions

- **Demand Proxy via Churn** ([ADR](docs/ADR/0001-demand-proxy-via-snapshot-churn.md)): Snapshot churn as demand estimate
- **Metadata Pipeline** ([ADR](docs/ADR/0002-item-metadata-pipeline.md)): Async resolver with priority queue + circuit breaker
- **Robust Statistics**: Median/MAD z-scores, not mean/std
- **Batch Queries + Cache**: N+1 eliminated; Upstash Redis (5-min TTL) for sub-100ms repeat loads
- **Graceful Degradation**: Missing metadata → show item_id; partial failures → serve stale data

## License

MIT
