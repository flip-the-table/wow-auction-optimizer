# WoW Auction Optimizer

Cloud-native web app that identifies high-demand, high-price World of Warcraft auction house items across all connected realms.

- **Hot Items Radar**: Sorted by "hotness" -- items with above-average demand AND price
- **Demand Proxy**: Snapshot churn (EWMA-smoothed) since Blizzard does not expose completed sales
- **Cross-Realm**: Recommends the best realm to sell each item on
- **Precomputed**: Background jobs crunch the data; UI serves instantly

## Architecture

```
┌─ Netlify ──────────────────────────┐
│  Next.js App                       │
│  ├── Frontend (React pages)        │
│  └── API Route Handlers            │
│       └── Neon Serverless Postgres ◄──── GitHub Actions (hourly)
└────────────────────────────────────┘     ├── ingest.py
                                          ├── compute.py
                                          └── meta_resolve.py
```

## Quick Start (Local Dev)

### Prerequisites
- **Python 3.11+** with pip
- **Node.js 18+** with npm
- **PostgreSQL 14+** (local install, [Neon.tech](https://neon.tech) free, or Docker)

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

# Option C: Neon.tech (create free project, copy connection string)
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

> **Note**: For local dev, set `DATABASE_URL` in `apps/web/.env.local` to your Postgres connection string (standard `postgresql://` format for the Neon driver).

---

## Deploy to Netlify (Free/Low Traffic)

| Service | Provider | Plan |
|---------|----------|------|
| Frontend + API | **Netlify** | Your credits |
| Database | [Neon.tech](https://neon.tech) | Free (0.5GB) |
| Redis | [Upstash](https://upstash.com) | Free (optional) |
| Background Jobs | **GitHub Actions** | Free (public repos) |

### Steps

1. **Neon Database**: Create a free project → copy the connection string.

2. **Netlify Deploy**:
   - Connect your GitHub repo to Netlify
   - `netlify.toml` is already configured (base: `apps/web`)
   - Add environment variables:
     - `DATABASE_URL` = your Neon connection string (use `postgresql://` format)
     - `REGION` = `us` (or `eu`)
     - `BASELINE_WINDOW_DAYS` = `14`

3. **Initialize Database**: Run the migration against your Neon DB:
   ```bash
   psql "your-neon-connection-string" -f migrations/001_initial.sql
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
1. Ingest auction data from Blizzard API
2. Compute hotness/features
3. Resolve item metadata

---

## GCP Production Deployment (Scale-Up Path)

See `infra/terraform/` for full Terraform configuration (Cloud Run, Cloud SQL, Memorystore, Cloud Scheduler).

---

## Project Structure

```
wow-auction-optimizer/
├── apps/web/                  Next.js (frontend + API routes)
│   └── src/app/api/           API Route Handlers (query Neon directly)
├── services/jobs/             Python background jobs
├── packages/shared/           Shared Python (Blizzard client, models)
├── migrations/                SQL schema
├── infra/terraform/           GCP IaC (optional)
├── docs/                      Architecture, ADRs, operations
├── .agent/workflows/          Agent workflow files
├── .github/workflows/         GitHub Actions
├── netlify.toml               Netlify build config
├── docker-compose.yml         Local Postgres + Redis (optional)
└── requirements.txt           Python deps
```

## Key Design Decisions

- **Demand Proxy via Churn** ([ADR](docs/ADR/0001-demand-proxy-via-snapshot-churn.md)): Snapshot churn as demand estimate
- **Metadata Pipeline** ([ADR](docs/ADR/0002-item-metadata-pipeline.md)): Async resolver with priority queue + circuit breaker
- **Robust Statistics**: Median/MAD z-scores, not mean/std
- **Graceful Degradation**: Missing metadata → show item_id; partial failures → serve stale data

## License

MIT
