# Architecture

## Deployment Model

```
┌─ AWS Amplify ─────────────────────────────┐
│  Next.js App (SSR)                        │
│  ├── Frontend: React pages (/, /item/[id])│
│  └── API Routes: /api/hot, /api/item/[id],│
│       /api/health, /api/realms            │
│       ├── postgres (porsager/postgres)    │
│       └── @upstash/redis (HTTP cache)     │
└──────────────────┬───────────┬────────────┘
                   │ SQL (TCP)  │ HTTP
              ┌────▼──────┐ ┌──▼──────────┐
              │  AWS RDS   │ │   Upstash   │
              │ PostgreSQL │ │    Redis    │
              └────┬───────┘ └─────────────┘
                   │
    ┌──────────────┼──────────────────┐
    │              │                  │
┌───▼────┐  ┌─────▼──────┐  ┌───────▼──────┐
│ Ingest │  │  Compute   │  │ Meta Resolve │
│  Job   │  │    Job     │  │     Job      │
└───┬────┘  └────────────┘  └──────┬───────┘
    │      GitHub Actions (hourly)  │
    │                               │
┌───▼───────────────────────────────▼───┐
│         Blizzard Game Data API        │
└───────────────────────────────────────┘
```

## Services

### Frontend + API (AWS Amplify)
- **Technology**: Next.js 14 App Router + TypeScript
- **API Pattern**: Route Handlers (`src/app/api/*/route.ts`)
- **Database Client**: `postgres` (porsager/postgres) — lightweight, TCP-based
- **Cache**: `@upstash/redis` — HTTP-based Redis with 5-min TTL
- **HTTP Caching**: `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`
- **Query Optimization**: Batch queries with JOINs and window functions (no N+1)

### Background Jobs (GitHub Actions)
- **Technology**: Python 3.11 + SQLAlchemy (async)
- **Schedule**: Hourly via `.github/workflows/jobs.yml`
- **Database Client**: `asyncpg` (persistent connections)
- **Blizzard API**: OAuth2 + token bucket rate limiter + ETag caching

### Database (AWS RDS)
- **Engine**: PostgreSQL 16
- **Tables**: realms, items, item_media, item_metadata_status, snapshots, item_realm_snapshot_metrics, item_realm_aggregates, item_realm_features_latest, item_realm_daily
- **Key Indexes**: `idx_features_hotness`, `idx_features_sell_suitability`

### Cache (Upstash Redis)
- **Purpose**: Cache full API JSON responses (5-min TTL)
- **Fallback**: Graceful degradation — if Redis unavailable, queries hit DB directly
- **Headers**: `X-Cache: HIT/MISS` for debugging

## Data Flow

1. **Cleanup Job** (before ingest):
   - Prunes snapshots older than 30 days
   - Keeps database size manageable

2. **Ingest Job** (hourly, GitHub Actions):
   - Fetches connected realm index from Blizzard API
   - For each realm: fetch auctions with ETag caching
   - Aggregates per-item metrics (buyout stats, listing count, quantity)
   - Computes demand proxy via snapshot churn + EWMA smoothing
   - Stores snapshots and metrics in Postgres
   - Queues new item IDs for metadata resolution

3. **Compute Job** (after ingest):
   - Loads 14-day rolling window of metrics
   - Computes baselines: median price, median demand per (realm, item)
   - Calculates robust z-scores via MAD
   - Computes hotness = 0.65 * demand_z + 0.35 * price_z
   - Computes confidence (freshness, snapshot count, volatility, liquidity)
   - Computes sell suitability: price_z × demand_z × confidence
   - Applies liquidity filters and upserts features_latest

4. **Meta Resolve Job** (periodic):
   - Fetches item name, quality, icon from Blizzard
   - Priority queue: hot items first, then high-listing, then long tail
   - Circuit breaker, distributed locks, bounded concurrency

5. **API Route Handlers** (request-time):
   - Check Upstash Redis cache first (5-min TTL)
   - On miss: batch query precomputed data from `item_realm_features_latest`
   - Join with items/item_media for display metadata
   - Cache response, return JSON with `Cache-Control` headers

## Performance Characteristics

| Route | DB Queries | Cold Load | Cached Load |
|-------|-----------|-----------|-------------|
| `/api/hot` | 2 (main + alternates batch) | ~1-2s | ~50-100ms |
| `/api/item/[id]` | 6 (parallel via Promise.all) | ~1s | ~50-100ms |

## Failure Modes

- **Partial ingest**: Failed realms skipped; stale data continues serving
- **Missing metadata**: UI shows item_id + placeholder icon
- **Database down**: API returns error; Next.js shows error state
- **Redis down**: Cache degrades gracefully; queries hit DB directly
- **Blizzard API down**: Jobs retry with backoff, eventually skip; stale data served

## Current Limitations

- Demand proxy based on snapshot churn, not actual sales
- Commodities endpoint not yet integrated into per-realm analysis
- Data freshness depends on GitHub Actions schedule (default 60 min)
- Time series aggregation uses simple median, not liquidity-weighted
