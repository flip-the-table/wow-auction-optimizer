# Architecture

## Deployment Model

```
┌─ Netlify ──────────────────────────────────┐
│  Next.js App (SSR + Edge Functions)        │
│  ├── Frontend: React pages (/, /item/[id]) │
│  └── API Routes: /api/hot, /api/item/[id], │
│       /api/health, /api/realms             │
│       └── @neondatabase/serverless         │
└──────────────────┬─────────────────────────┘
                   │ SQL (HTTP)
              ┌────▼──────┐
              │  Neon.tech │ (Serverless Postgres)
              │  Postgres  │
              └────┬───────┘
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

### Frontend + API (Netlify)
- **Technology**: Next.js 14 App Router + TypeScript
- **API Pattern**: Route Handlers (`src/app/api/*/route.ts`)
- **Database Client**: `@neondatabase/serverless` (HTTP-based, no connection pooling needed)
- **Runtime**: Netlify Edge Functions for minimal cold starts
- **Caching**: Next.js `revalidate` (ISR) -- responses cached for 60s

### Background Jobs (GitHub Actions)
- **Technology**: Python 3.11 + SQLAlchemy (async)
- **Schedule**: Hourly via `.github/workflows/jobs.yml`
- **Database Client**: `asyncpg` (persistent connections)
- **Blizzard API**: OAuth2 + token bucket rate limiter + ETag caching

### Database (Neon.tech)
- **Engine**: PostgreSQL 16 (serverless)
- **Tables**: realms, items, item_media, item_metadata_status, snapshots, item_realm_snapshot_metrics, item_realm_features_latest
- **Key Indexes**: `idx_features_hotness`, `idx_features_sell_suitability`

## Data Flow

1. **Ingest Job** (hourly, GitHub Actions):
   - Fetches connected realm index from Blizzard API
   - For each realm: fetch auctions with ETag caching
   - Aggregates per-item metrics (buyout stats, listing count, quantity)
   - Computes demand proxy via snapshot churn + EWMA smoothing
   - Stores snapshots and metrics in Postgres
   - Queues new item IDs for metadata resolution

2. **Compute Job** (after ingest):
   - Loads 14-day rolling window of metrics
   - Computes baselines: median price, median demand per (realm, item)
   - Calculates robust z-scores via MAD
   - Computes hotness = 0.65 * demand_z + 0.35 * price_z
   - Computes confidence (freshness, snapshot count, volatility, liquidity)
   - Computes sell suitability: price_z × demand_z × confidence
   - Applies liquidity filters and upserts features_latest

3. **Meta Resolve Job** (periodic):
   - Fetches item name, quality, icon from Blizzard
   - Priority queue: hot items first, then high-listing, then long tail
   - Circuit breaker, distributed locks, bounded concurrency

4. **API Route Handlers** (request-time):
   - Query precomputed data from `item_realm_features_latest`
   - Join with items/item_media for display metadata
   - Return JSON with timestamps and baseline window

## Failure Modes

- **Partial ingest**: Failed realms skipped; stale data continues serving
- **Missing metadata**: UI shows item_id + placeholder icon
- **Database down**: API returns error; Next.js shows error state
- **Blizzard API down**: Jobs retry with backoff, eventually skip; stale data served

## Current Limitations

- Demand proxy based on snapshot churn, not actual sales
- Commodities endpoint not yet integrated into per-realm analysis
- Data freshness depends on GitHub Actions schedule (default 60 min)
- Time series aggregation uses simple median, not liquidity-weighted
