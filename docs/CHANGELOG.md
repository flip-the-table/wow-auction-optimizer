# Changelog

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
- Free cloud deployment (Vercel + Render + Neon + Upstash)
- GCP production deployment (Terraform)
