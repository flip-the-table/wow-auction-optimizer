# Changelog

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
