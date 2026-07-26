# Changelog

## 2026-07-26: Implied Lumber Value & Decor Conversion Engine

- New `/lumber` page + `/api/material-value` + `/api/decor-opportunities`:
  modeled opportunity value of non-tradeable lumber inferred from decor
  conversions (never labeled a market price; full calculation drawer with
  OBSERVED/DERIVED/MODELED/CURATED classifications; feature-flagged via
  `LUMBER_FEATURE_ENABLED`).
- Versioned curated decor-recipe source (`data/decor_recipes/`), immutable
  checksummed imports via `decor_recipe_load.py` + dispatch workflow; no
  production mapping is seeded — the UI shows an honest empty state until a
  verified source is imported.
- Pure valuation engine (`lumber_valuation.py`) + precompute orchestration
  (`lumber_compute.py`) writing `decor_recipe_valuations` /
  `material_value_summaries`; formula-version registry with immutability
  enforcement.
- Prerequisite fixes: ingest now fails on all-realm/below-threshold failure;
  compute holds a Postgres advisory lock (no overlapping runs); AH-derived
  reagent prices older than 48h excluded from craft costs; VWAP
  price/quantity mispairing fixed (+ tests, 44 passing); pytest CI workflow.

---

## 2026-07-25: Staleness + Performance Audit

### Data Correctness
- **Stale feature purge**: `compute.py` now deletes `item_realm_features_latest` rows not
  refreshed by the current run. Zombie "hot" items (some frozen since February) no longer
  pollute the radar.
- **`/api/health` and `/api/realms` were prerendered at build time** (no `request` usage →
  Next.js static route) and served frozen JSON since the Feb 20 deploy. Now `force-dynamic`.
- **Item daily trend charts** returned the *oldest* N days instead of the most recent
  (`ORDER BY date ASC LIMIT n`). Now newest-first, re-sorted ascending for charting.
- **Confidence volatility factor** was computed as std/std (≈ always 0); now a proper
  coefficient of variation (std/mean, clamped).

### Performance
- **`/api/hot` 504s fixed**: cold requests took 20-30s because realm counts were
  pre-aggregated over the entire ~1.5M-row `item_realm_aggregates` table per request.
  Counts now computed only for the returned page via indexed correlated subqueries.
- **New index** `ix_aggregates_region_item (region, item_id)` — created idempotently by
  `cleanup.py` and included in models + migration.
- **`compute.py`** filters liquidity in SQL (was loading ~1.5M ORM rows to keep ~1k) and
  upserts in multi-row batches (was one statement per row).
- **`item_realm_daily` pruned to 90 days** in cleanup (previously unbounded growth).

### Robustness / Visuals
- `/api/hot` fully parameterized (no string-built SQL), NaN-safe query params, BIGINT
  fields coerced to numbers; invalid item id returns 400.
- Fixed undefined `--bg-base` (transparent sticky filter bar) and sticky `thead` silently
  disabled inside `overflow-x: auto` wrapper (now sticky on wide screens, static + scrollable
  under 1100px).
- Title intro animation plays once per session instead of hiding the title 6.5s on every load.
- SPA navigation (`router.push`) for row clicks; Suspense fallback matches real table.

### Docs
- README reflects daily 08:00 UTC cron (was hourly); migration now includes
  `item_realm_aggregates` + `item_realm_daily` definitions.

---

## 2026-02-17: Performance + All Realms

### Performance
- **API Latency**: `/api/hot` reduced from 30+ seconds to ~1-2s (cold) / ~50-100ms (cached)
  - Eliminated N+1 query pattern (151 queries → 2 batch queries)
  - Added Upstash Redis caching with 5-minute TTL
  - Added `Cache-Control: stale-while-revalidate` headers
- **Item Detail API**: 5-6 sequential queries → parallel via `Promise.all`

### All Realms Display
- Main UI shows total realm count per item with expandable hot alternates
- Item detail page splits realms into "hot" (full sizzle stats) and "price-only" sections
- Expand/collapse for non-hot realms to keep UI clean

### Infrastructure
- Migrated database from Neon to **AWS RDS** (PostgreSQL)
- Migrated frontend from Netlify to **AWS Amplify**
- Added **Upstash Redis** for API response caching
- Updated GitHub Actions secrets for RDS

### UX Polish
- Gold left-border accent on row hover
- Focus-visible keyboard accessibility
- Sort indicators on active columns
- Smooth button transitions

---

## 2026-02-15: Initial Release

### Features
- **Hot Items Radar**: Region-wide view of top items sorted by hotness score (weighted demand_z + price_z).
- **Cross-Realm Recommendations**: Best realm to sell each item with top 5 alternates.
- **Item Detail Page**: 7/14/30-day sparklines for price and demand, realm leaderboard.
- **Demand Proxy**: Snapshot churn-based demand estimation with EWMA smoothing.
- **Robust Statistics**: Median/MAD-based z-scores, composite confidence scoring.
- **Item Metadata Pipeline**: Async resolver with priority queue, circuit breaker, distributed locks.
- **Premium UI**: WoW-inspired dark theme with gold/purple accents, glassmorphism, gold/silver/copper coins.
- **Graceful Degradation**: Missing metadata shows item_id + placeholder; partial failures do not break serving.

### Deployment
- Local dev without Docker (Postgres + Python + Node)
- Cloud deployment (AWS Amplify + RDS + Upstash)
- GCP production deployment (Terraform, optional)
