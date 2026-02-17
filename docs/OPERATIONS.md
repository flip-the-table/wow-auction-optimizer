# Operations Guide

## Environment Variables

All configuration is via environment variables. See `.env.example` for the full list.

### Required
| Variable | Description |
|----------|-------------|
| `BLIZZARD_CLIENT_ID` | Blizzard OAuth client ID |
| `BLIZZARD_CLIENT_SECRET` | Blizzard OAuth client secret |
| `DATABASE_URL` | Async Postgres connection (asyncpg format for Python jobs) |
| `DATABASE_URL_SYNC` | Sync Postgres connection (standard format) |

### Optional
| Variable | Default | Description |
|----------|---------|-------------|
| `UPSTASH_REDIS_REST_URL` | *(none)* | Upstash Redis REST URL (enables API caching) |
| `UPSTASH_REDIS_REST_TOKEN` | *(none)* | Upstash Redis REST token |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection for Python jobs |
| `REGION` | `us` | Blizzard region: us or eu |
| `LOCALE` | `en_US` | Item name locale |
| `INGEST_INTERVAL_MINUTES` | `60` | How often to run ingest |
| `WEIGHT_DEMAND` | `0.65` | Hotness weight for demand |
| `WEIGHT_PRICE` | `0.35` | Hotness weight for price |
| `MIN_LISTING_COUNT` | `20` | Liquidity filter |
| `MIN_TOTAL_QUANTITY` | `50` | Liquidity filter |
| `EWMA_ALPHA` | `0.3` | Demand smoothing factor |
| `BASELINE_WINDOW_DAYS` | `14` | Rolling baseline window |

## Secrets Management

### Where Secrets Live

| Context | Mechanism | Secrets |
|---------|-----------|---------|
| **Local dev** | `.env` file (gitignored) | All vars |
| **GitHub Actions** | Repo secrets (`gh secret set`) | `DATABASE_URL`, `DATABASE_URL_SYNC`, `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `REDIS_URL` |
| **AWS Amplify** | Amplify environment variables | `DATABASE_URL`, `REGION`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |

### Security Notes
- `.env` is in `.gitignore` — never committed
- `.env.example` uses placeholder values only
- API routes are server-side only (Next.js Route Handlers) — credentials never reach the browser
- Repo is **private** — source code not publicly visible

## Running Locally

### Without Docker
```bash
# 1. Install Postgres locally and create the database
createdb wow_auction
psql -d wow_auction -f migrations/001_initial.sql

# 2. Install Python deps
pip install -r requirements.txt

# 3. Run jobs
python -m services.jobs.ingest
python -m services.jobs.compute
python -m services.jobs.meta_resolve

# 4. Start frontend
cd apps/web && npm install && npm run dev
```

### With Docker (infrastructure only)
```bash
docker-compose up -d postgres redis
pip install -r requirements.txt
python -m services.jobs.ingest
# ... rest same as above
```

## Running Jobs

### Cleanup
```bash
python -m services.jobs.cleanup
```
Prunes old snapshots (>30 days) to keep database size manageable. Runs automatically before ingest in GitHub Actions.

### Ingest
```bash
python -m services.jobs.ingest
```
Fetches auction data for all connected realms. Takes 5-15 minutes depending on rate limits and number of realms. Safe to run repeatedly -- uses ETag caching to skip unchanged data.

### Compute
```bash
python -m services.jobs.compute
```
Computes features from stored metrics. Should run after each ingest. Takes 1-3 minutes depending on data volume.

### Metadata Resolver
```bash
python -m services.jobs.meta_resolve
```
Fetches item names and icons from Blizzard. Prioritizes hot items. Can be run independently at any frequency. Uses circuit breaker to avoid rate limit cascades.

## Debugging

### Check health
```bash
curl http://localhost:3000/api/health | python -m json.tool
```

### Check cache status
Look for `X-Cache: HIT` or `X-Cache: MISS` in response headers:
```bash
curl -I http://localhost:3000/api/hot
```

### Check data freshness
```sql
SELECT region, connected_realm_id, MAX(fetched_at) as last_ingest
FROM snapshots WHERE status = 'success'
GROUP BY region, connected_realm_id
ORDER BY last_ingest DESC;
```

### Check metadata coverage
```sql
SELECT status, COUNT(*) FROM item_metadata_status GROUP BY status;
```

### Check top hot items
```sql
SELECT f.item_id, i.name, f.hotness_score, f.confidence
FROM item_realm_features_latest f
LEFT JOIN items i ON f.item_id = i.id
WHERE f.region = 'us'
ORDER BY f.hotness_score DESC
LIMIT 20;
```

## Recovery

### Re-ingest a specific realm
Currently all realms are ingested together. To re-ingest after a failure, simply re-run the ingest job.

### Backfill metadata
```bash
# Reset failed items to pending and re-run
psql -d wow_auction -c "UPDATE item_metadata_status SET status='pending', attempts=0 WHERE status='failed';"
python -m services.jobs.meta_resolve
```

### Recompute features
```bash
# Delete stale features and recompute
psql -d wow_auction -c "DELETE FROM item_realm_features_latest;"
python -m services.jobs.compute
```

### Flush Redis cache
If stale data is being served and you need an immediate refresh:
```bash
# Via Upstash dashboard, or:
# The cache uses 5-min TTL, so waiting 5 minutes also works.
```
