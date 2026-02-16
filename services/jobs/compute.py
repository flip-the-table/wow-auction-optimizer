"""
Compute Job -- Reads aggregate stats and computes item features (z-scores, hotness).

This job:
1. Reads running stats from item_realm_aggregates (Welford's mean/variance).
2. Computes z-scores for price and demand using the stored running stats.
3. Computes hotness_score, sell_suitability_score, and confidence.
4. UPSERTs results into item_realm_features_latest for the API to serve.

Run: python -m services.jobs.compute
"""

import asyncio
import logging
import math
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from packages.shared.config import get_settings
from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import (
    Base,
    ItemRealmAggregate,
    ItemRealmFeaturesLatest,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("compute")


def welford_std(m2: float, count: int) -> float:
    """Recover standard deviation from Welford's M2 and count."""
    if count < 2:
        return 0.0
    variance = m2 / (count - 1)
    return math.sqrt(max(0.0, variance))


def compute_z(value: float, mean: float, m2: float, count: int) -> float:
    """Compute z-score from Welford's running stats."""
    std = welford_std(m2, count)
    if std < 1e-9:
        return 0.0
    return (value - mean) / std


def compute_confidence(
    snapshot_count: int,
    min_snapshots: int,
    listing_count: int,
    total_quantity: int,
    min_listing_count: int,
    min_total_quantity: int,
    price_std: float,
    demand_std: float,
) -> float:
    """
    Compute confidence score [0, 1] based on data quality.

    Weighted combination of:
    - Snapshot count factor (30%): have we seen enough data points?
    - Volatility factor (30%): low volatility = more confident
    - Liquidity factor (40%): enough listings + quantity?
    """
    # Snapshot count factor
    count_factor = min(1.0, snapshot_count / max(min_snapshots, 1))

    # Volatility factor (lower is better)
    price_cv = price_std / max(1.0, abs(price_std) + 1e-9)
    demand_cv = demand_std / max(1.0, abs(demand_std) + 1e-9)
    avg_cv = (price_cv + demand_cv) / 2
    volatility = max(0.0, 1.0 - avg_cv)

    # Liquidity factor
    liquidity = min(1.0, (
        listing_count / max(min_listing_count * 3, 1) * 0.5 +
        total_quantity / max(min_total_quantity * 3, 1) * 0.5
    ))

    confidence = (
        count_factor * 0.30 +
        volatility * 0.30 +
        liquidity * 0.40
    )

    return round(max(0.0, min(1.0, confidence)), 4)


async def run_compute():
    """Main compute job entry point."""
    settings = get_settings()
    logger.info(
        "Starting compute job for region=%s",
        settings.region,
    )

    t0 = time.monotonic()
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = get_async_session_factory()
    now = datetime.now(timezone.utc)

    async with session_factory() as session:
        # Load all aggregates for the region
        stmt = (
            select(ItemRealmAggregate)
            .where(ItemRealmAggregate.region == settings.region)
        )
        result = await session.execute(stmt)
        aggregates = result.scalars().all()

        if not aggregates:
            logger.warning("No aggregates found, nothing to compute")
            return

        logger.info("Processing %d aggregate rows", len(aggregates))

        features_batch = []
        total_items = 0

        for agg in aggregates:
            # Current values
            current_price = agg.median_buyout or 0
            current_demand = agg.demand_proxy_smoothed or 0.0

            # Z-scores from Welford's running stats
            price_z = compute_z(
                float(current_price),
                agg.price_mean or 0.0,
                agg.price_m2 or 0.0,
                agg.snapshot_count or 0,
            )
            demand_z = compute_z(
                current_demand,
                agg.demand_mean or 0.0,
                agg.demand_m2 or 0.0,
                agg.snapshot_count or 0,
            )

            # Percentage deviations from running mean
            eps = 1e-9
            baseline_price = agg.price_mean or float(current_price)
            baseline_demand = agg.demand_mean or current_demand
            price_pct_diff = (float(current_price) - baseline_price) / max(abs(baseline_price), eps)
            demand_pct_diff = (current_demand - baseline_demand) / max(abs(baseline_demand), eps)

            # Hotness score
            hotness = (
                settings.weight_demand * demand_z +
                settings.weight_price * price_z
            )

            # Standard deviations for confidence
            price_std = welford_std(agg.price_m2 or 0.0, agg.snapshot_count or 0)
            demand_std = welford_std(agg.demand_m2 or 0.0, agg.snapshot_count or 0)

            # Confidence
            confidence = compute_confidence(
                snapshot_count=agg.snapshot_count or 0,
                min_snapshots=settings.min_snapshots_for_confidence,
                listing_count=agg.listing_count or 0,
                total_quantity=agg.total_quantity or 0,
                min_listing_count=settings.min_listing_count,
                min_total_quantity=settings.min_total_quantity,
                price_std=price_std,
                demand_std=demand_std,
            )

            # Sell suitability: items with high price AND high demand AND high confidence
            sell_suitability = max(0, price_z) * max(0, demand_z) * confidence

            # Liquidity filter
            if (agg.listing_count or 0) < settings.min_listing_count:
                continue
            if (agg.total_quantity or 0) < settings.min_total_quantity:
                continue

            features_batch.append({
                "region": settings.region,
                "connected_realm_id": agg.connected_realm_id,
                "item_id": agg.item_id,
                "current_price": current_price,
                "current_demand": round(current_demand, 6),
                "baseline_price": int(baseline_price),
                "baseline_demand": round(baseline_demand, 6),
                "price_pct_diff": round(price_pct_diff, 4),
                "demand_pct_diff": round(demand_pct_diff, 4),
                "price_z": round(price_z, 4),
                "demand_z": round(demand_z, 4),
                "hotness_score": round(hotness, 4),
                "sell_suitability_score": round(sell_suitability, 4),
                "confidence": confidence,
                "listing_count": agg.listing_count or 0,
                "total_quantity": agg.total_quantity or 0,
                "baseline_window_days": settings.baseline_window_days,
                "snapshot_count": agg.snapshot_count or 0,
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
