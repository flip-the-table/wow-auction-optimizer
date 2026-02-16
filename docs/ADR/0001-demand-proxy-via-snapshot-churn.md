# ADR 0001: Demand Proxy via Snapshot Churn

## Status
Accepted

## Context
Blizzard auction APIs provide current listings (price, quantity) but not completed sales. We need a demand proxy to identify "items selling like hotcakes."

## Decision
Use snapshot churn as the demand proxy:
- `churn_qty = max(0, Q_{t-1} - Q_t)` (quantity decrease between snapshots)
- `normalized_churn = churn_qty / max(Q_{t-1}, 1) / max(dt_hours, eps)`
- Smooth with EWMA: `demand_smoothed = alpha * normalized_churn + (1-alpha) * prior`

## Rationale
- Quantity decrease between snapshots implies items were purchased.
- Normalization by previous quantity accounts for different item scales.
- Time normalization accounts for variable snapshot intervals.
- EWMA smoothing (alpha=0.3) provides temporal stability while remaining responsive.

## Consequences
- Replenishment (quantity increases) results in churn=0, which can mask continuing demand.
- Large snapshot gaps reduce accuracy -- handled via confidence penalty.
- Not a true sales count -- items could also expire or be cancelled.
- Adequate for relative ranking (comparing items against their own baselines).
