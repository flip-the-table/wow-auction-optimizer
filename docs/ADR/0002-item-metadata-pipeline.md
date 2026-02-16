# ADR 0002: Item Metadata Pipeline

## Status
Accepted

## Context
Naive per-item metadata fetching triggers 429 rate limits and leads to incomplete coverage. Metadata must never be fetched in the web request path.

## Decision
Implement a dedicated, asynchronous metadata resolver pipeline:
1. Ingest job records new item_ids in `item_metadata_status` with status='pending'.
2. Resolver job processes pending items with:
   - Priority queue: hot items first, then by listing count.
   - Bounded concurrency (default 5 concurrent requests).
   - Distributed locks via Redis to prevent duplicate requests.
   - Circuit breaker: opens after 10 429s in 60s, cools down 30s.
3. Resolved metadata cached in Redis (7d TTL) and stored in Postgres (authoritative).
4. UI gracefully handles missing metadata (shows item_id + placeholder).

## Rationale
- Decouples metadata resolution from serving path -- UI never blocks on metadata.
- Priority queue ensures most-visible items get metadata first.
- Circuit breaker prevents cascading failure under rate limits.
- Distributed locks prevent wasted requests on the same item.

## Consequences
- Some items may show as "Item #12345" without names/icons initially.
- After 24h of operation, top 1,000 items should have >99% coverage.
- Long-tail items may take days to fully resolve.
