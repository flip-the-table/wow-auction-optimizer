"""
Compute Job -- Calculates rolling baselines, z-scores, hotness, and confidence.

This job runs after ingest and:
1. Loads the rolling window of snapshot metrics (default 14 days).
2. Computes per-realm-per-item baselines: median price, median demand.
3. Computes regional per-item baselines: median across all realms.
4. Calculates robust z-scores: (current - median) / (1.4826 * MAD + eps).
5. Computes hotness score (weighted demand_z + price_z).
6. Computes confidence (freshness, snapshot count, volatility, liquidity).
7. Computes sell suitability (price_z * demand_z * confidence).
8. Applies liquidity filters and upserts item_realm_features_latest.

Run: python -m services.jobs.compute
"""

import asyncio
import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, text, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert

from packages.shared.config import get_settings
from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import (
    Base,
    ItemRealmFeaturesLatest,
    ItemRealmSnapshotMetric,
    Snapshot,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("compute")


def robust_z(values: np.ndarray, current: float) -> tuple[float, float, float]:
    """
    Compute robust z-score using median and MAD.

    MAD = median absolute deviation
    robust_z = (current - median) / (1.4826 * MAD + eps)

    The factor 1.4826 makes MAD a consistent estimator for
    the standard deviation of a normal distribution.

    Returns: (median, mad, z_score)
    """
    eps = 1e-9
    if len(values) == 0:
        return 0.0, 0.0, 0.0

    median = float(np.median(values))
    mad = float(np.median(np.abs(values - median)))
    z = (current - median) / (1.4826 * mad + eps)

    return median, mad, z


def compute_confidence(
    snapshot_count: int,
    min_snapshots: int,
    latest_fetched_at: datetime,
    now: datetime,
    mad_price: float,
    mad_demand: float,
    listing_count: int,
    total_quantity: int,
    min_listing_count: int,
    min_total_quantity: int,
) -> float:
    """
    Composite confidence score (0..1) based on:
    - snapshot_count: more snapshots => higher confidence
    - freshness: older data => exponential decay
    - volatility: high MAD => lower confidence
    - liquidity: more listings/quantity => higher confidence
    """
    # Snapshot count factor (sigmoid-like)
    count_factor = min(1.0, snapshot_count / max(min_snapshots * 2, 1))

    # Freshness factor (exponential decay, half-life = 2 hours)
    if latest_fetched_at.tzinfo is None:
        latest_fetched_at = latest_fetched_at.replace(tzinfo=timezone.utc)
    age_hours = (now - latest_fetched_at).total_seconds() / 3600.0
    freshness_factor = 2.0 ** (-age_hours / 2.0)

    # Volatility penalty (higher MAD => lower confidence)
    volatility = 1.0 / (1.0 + 0.1 * (mad_price + mad_demand))

    # Liquidity bonus
    liquidity = min(1.0, (
        listing_count / max(min_listing_count * 3, 1) * 0.5 +
        total_quantity / max(min_total_quantity * 3, 1) * 0.5
    ))

    confidence = (
        count_factor * 0.30 +
        freshness_factor * 0.30 +
        volatility * 0.20 +
        liquidity * 0.20
    )

    return round(max(0.0, min(1.0, confidence)), 4)


async def run_compute():
    """Main compute job entry point."""
    settings = get_settings()
    logger.info(
        "Starting compute job for region=%s, window=%d days",
        settings.region,
        settings.baseline_window_days,
    )

    t0 = time.monotonic()
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = get_async_session_factory()
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=settings.baseline_window_days)

    async with session_factory() as session:
        # Get all snapshots in window
        stmt = (
            select(Snapshot)
            .where(Snapshot.region == settings.region)
            .where(Snapshot.status == "success")
            .where(Snapshot.fetched_at >= window_start)
            .order_by(Snapshot.fetched_at.asc())
        )
        result = await session.execute(stmt)
        snapshots = result.scalars().all()
        snapshot_ids = [s.id for s in snapshots]
        snapshot_times = {s.id: s.fetched_at for s in snapshots}
        snapshot_realms = {s.id: s.connected_realm_id for s in snapshots}

        if not snapshot_ids:
            logger.warning("No snapshots found in window, nothing to compute")
            return

        logger.info(
            "Found %d snapshots in %d-day window",
            len(snapshot_ids),
            settings.baseline_window_days,
        )

        # Load all metrics in the window
        # Process in batches by connected_realm_id to manage memory
        distinct_realms_stmt = (
            select(Snapshot.connected_realm_id)
            .where(Snapshot.id.in_(snapshot_ids))
            .distinct()
        )
        result = await session.execute(distinct_realms_stmt)
        connected_realm_ids = [row[0] for row in result]

        logger.info("Computing features for %d connected realms", len(connected_realm_ids))

        features_batch = []
        total_items = 0

        for cr_id in connected_realm_ids:
            # Get snapshot IDs for this realm
            realm_snapshot_ids = [
                sid for sid in snapshot_ids if snapshot_realms.get(sid) == cr_id
            ]
            if not realm_snapshot_ids:
                continue

            # Load metrics for this realm
            stmt = (
                select(ItemRealmSnapshotMetric)
                .where(ItemRealmSnapshotMetric.snapshot_id.in_(realm_snapshot_ids))
                .where(ItemRealmSnapshotMetric.connected_realm_id == cr_id)
            )
            result = await session.execute(stmt)
            metrics = result.scalars().all()

            if not metrics:
                continue

            # Group by item_id
            item_metrics: dict[int, list] = {}
            for m in metrics:
                item_metrics.setdefault(m.item_id, []).append(m)

            latest_snapshot_id = max(realm_snapshot_ids)

            for item_id, item_rows in item_metrics.items():
                # Sort by snapshot_id (ascending)
                item_rows.sort(key=lambda x: x.snapshot_id)

                # Current values = latest snapshot
                latest = item_rows[-1]
                current_price = latest.median_buyout or 0
                current_demand = latest.demand_proxy_smoothed or 0.0

                # Collect historical values
                prices = np.array([
                    r.median_buyout for r in item_rows
                    if r.median_buyout is not None and r.median_buyout > 0
                ], dtype=np.float64)

                demands = np.array([
                    r.demand_proxy_smoothed for r in item_rows
                    if r.demand_proxy_smoothed is not None
                ], dtype=np.float64)

                if len(prices) == 0 or len(demands) == 0:
                    continue

                # Robust z-scores (single-point: z=0, baseline=current)
                median_price, mad_price, price_z = robust_z(prices, float(current_price))
                median_demand, mad_demand, demand_z = robust_z(demands, current_demand)

                # Percentage deviations
                eps = 1e-9
                price_pct_diff = (current_price - median_price) / max(median_price, eps)
                demand_pct_diff = (current_demand - median_demand) / max(median_demand, eps)

                # Hotness score
                hotness = (
                    settings.weight_demand * demand_z +
                    settings.weight_price * price_z
                )

                # Confidence
                latest_time = snapshot_times.get(latest.snapshot_id, now)
                confidence = compute_confidence(
                    snapshot_count=len(item_rows),
                    min_snapshots=settings.min_snapshots_for_confidence,
                    latest_fetched_at=latest_time,
                    now=now,
                    mad_price=mad_price,
                    mad_demand=mad_demand,
                    listing_count=latest.listing_count or 0,
                    total_quantity=latest.total_quantity or 0,
                    min_listing_count=settings.min_listing_count,
                    min_total_quantity=settings.min_total_quantity,
                )

                # Sell suitability: items with high price AND high demand AND high confidence
                sell_suitability = (
                    max(0, price_z) * max(0, demand_z) * confidence
                )

                # Liquidity filter
                if (latest.listing_count or 0) < settings.min_listing_count:
                    continue
                if (latest.total_quantity or 0) < settings.min_total_quantity:
                    continue

                features_batch.append({
                    "region": settings.region,
                    "connected_realm_id": cr_id,
                    "item_id": item_id,
                    "current_price": current_price,
                    "current_demand": round(current_demand, 6),
                    "baseline_price": int(median_price),
                    "baseline_demand": round(median_demand, 6),
                    "price_pct_diff": round(price_pct_diff, 4),
                    "demand_pct_diff": round(demand_pct_diff, 4),
                    "price_z": round(price_z, 4),
                    "demand_z": round(demand_z, 4),
                    "hotness_score": round(hotness, 4),
                    "sell_suitability_score": round(sell_suitability, 4),
                    "confidence": confidence,
                    "listing_count": latest.listing_count or 0,
                    "total_quantity": latest.total_quantity or 0,
                    "baseline_window_days": settings.baseline_window_days,
                    "snapshot_count": len(item_rows),
                    "updated_at": now,
                })
                total_items += 1

                # Flush in batches of 1000
                if len(features_batch) >= 1000:
                    await _upsert_features(session, features_batch)
                    features_batch = []

        # Final flush
        if features_batch:
            await _upsert_features(session, features_batch)

        await session.commit()

    elapsed = time.monotonic() - t0
    logger.info(
        "Compute complete: %d item-realm features upserted in %.1fs",
        total_items,
        elapsed,
    )


async def _upsert_features(session, batch: list[dict]):
    """Upsert a batch of features into item_realm_features_latest."""
    for row in batch:
        stmt = pg_insert(ItemRealmFeaturesLatest.__table__).values(**row)
        stmt = stmt.on_conflict_do_update(
            index_elements=["region", "connected_realm_id", "item_id"],
            set_={k: v for k, v in row.items() if k not in ("region", "connected_realm_id", "item_id")},
        )
        await session.execute(stmt)


if __name__ == "__main__":
    asyncio.run(run_compute())
