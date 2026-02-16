"""
Ingest Job -- Fetches auction data from Blizzard API and updates aggregate stats.

This job:
1. Fetches the connected realm index and upserts realm records.
2. For each connected realm, fetches auction listings.
3. Aggregates per-item metrics: listing_count, total_quantity, buyout stats.
4. Computes demand proxy from delta vs previous aggregate.
5. UPSERTs running stats into item_realm_aggregates (Welford's + EWMA).
6. Queues unresolved item IDs for metadata resolution.

Run: python -m services.jobs.ingest
"""

import asyncio
import logging
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from packages.shared.blizzard_client import BlizzardClient, NOT_MODIFIED
from packages.shared.config import get_settings
from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import (
    Base,
    ItemMetadataStatus,
    ItemRealmAggregate,
    Realm,
    Snapshot,
)
from packages.shared.redis_client import get_redis, close_redis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ingest")


async def ensure_tables():
    """Create tables if they don't exist (for local dev convenience)."""
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def extract_connected_realm_id(href: str) -> int:
    """Extract numeric ID from connected realm href URL."""
    path = href.split("?")[0]
    return int(path.rstrip("/").split("/")[-1])


async def ingest_realms(client: BlizzardClient, session_factory) -> list[int]:
    """Fetch connected realm index, upsert realm records. Returns list of connected realm IDs."""
    logger.info("Fetching connected realm index...")
    realm_index = await client.get_connected_realm_index()

    connected_realm_ids = []
    for entry in realm_index:
        href = entry.get("href", "")
        cr_id = extract_connected_realm_id(href)
        connected_realm_ids.append(cr_id)

    logger.info("Found %d connected realms, fetching details...", len(connected_realm_ids))

    async with session_factory() as session:
        for cr_id in connected_realm_ids:
            try:
                detail = await client.get_connected_realm(cr_id)
                realms_data = detail.get("realms", [])
                for r in realms_data:
                    realm_id = r.get("id")
                    slug = r.get("slug", "")
                    name = r.get("name", {})
                    if isinstance(name, dict):
                        name = name.get(get_settings().locale, name.get("en_US", str(realm_id)))
                    stmt = pg_insert(Realm.__table__).values(
                        id=realm_id,
                        slug=slug,
                        name=str(name),
                        region=get_settings().region,
                        connected_realm_id=cr_id,
                        updated_at=datetime.now(timezone.utc),
                    ).on_conflict_do_update(
                        index_elements=["id"],
                        set_={
                            "slug": slug,
                            "name": str(name),
                            "connected_realm_id": cr_id,
                            "updated_at": datetime.now(timezone.utc),
                        },
                    )
                    await session.execute(stmt)
            except Exception as e:
                logger.warning("Failed to fetch realm detail for %d: %s", cr_id, e)
                continue

        await session.commit()

    logger.info("Upserted realms for %d connected realms", len(connected_realm_ids))
    return connected_realm_ids


def compute_buyout_stats(auctions: list[dict]) -> dict[int, dict]:
    """
    Aggregate per-item auction metrics.

    For each item_id, computes:
    - listing_count: number of distinct auction listings
    - total_quantity: sum of quantities
    - min/median/mean buyout (unit price)
    - vwap_buyout: volume-weighted average price

    Buyout prices in the API are in copper (1 gold = 10000 copper).
    Some items use "unit_price" (commodities) vs "buyout" (regular auctions).
    """
    item_data: dict[int, dict] = {}

    for auction in auctions:
        item_id = auction.get("item", {}).get("id")
        if item_id is None:
            continue

        quantity = auction.get("quantity", 1)
        # unit_price for commodities, buyout for regular auctions
        buyout = auction.get("unit_price") or auction.get("buyout") or 0
        if buyout <= 0:
            continue

        if item_id not in item_data:
            item_data[item_id] = {
                "buyouts": [],
                "quantities": [],
                "listing_count": 0,
                "total_quantity": 0,
            }

        entry = item_data[item_id]
        entry["buyouts"].append(buyout)
        entry["quantities"].append(quantity)
        entry["listing_count"] += 1
        entry["total_quantity"] += quantity

    result = {}
    for item_id, data in item_data.items():
        buyouts = sorted(data["buyouts"])
        quantities = data["quantities"]

        # VWAP: sum(price * qty) / sum(qty)
        total_value = sum(b * q for b, q in zip(buyouts, quantities))
        total_qty = data["total_quantity"]

        result[item_id] = {
            "listing_count": data["listing_count"],
            "total_quantity": total_qty,
            "min_buyout": buyouts[0] if buyouts else None,
            "median_buyout": int(statistics.median(buyouts)) if buyouts else None,
            "mean_buyout": int(statistics.mean(buyouts)) if buyouts else None,
            "vwap_buyout": int(total_value / max(total_qty, 1)),
        }

    return result


def compute_demand_proxy(
    current_qty: int,
    prev_qty: int,
    current_listings: int,
    prev_listings: int,
    dt_hours: float,
    prev_smoothed: float,
    alpha: float,
) -> tuple[float, float]:
    """
    Compute demand proxy via snapshot churn.

    Demand proxy = normalized_churn = max(0, Q_{t-1} - Q_t) / max(Q_{t-1}, 1) / max(dt_hours, 0.01)
    Returns: (demand_proxy_raw, demand_proxy_smoothed)
    """
    eps = 0.01
    churn_qty = max(0, prev_qty - current_qty)
    normalized_churn = churn_qty / max(prev_qty, 1) / max(dt_hours, eps)
    smoothed = alpha * normalized_churn + (1 - alpha) * prev_smoothed
    return normalized_churn, smoothed


def welford_update(
    count: int, mean: float, m2: float, new_value: float
) -> tuple[int, float, float]:
    """Welford's online algorithm for running mean and variance.

    Returns: (new_count, new_mean, new_m2)
    To recover variance: variance = m2 / max(count - 1, 1)
    """
    count += 1
    delta = new_value - mean
    mean += delta / count
    delta2 = new_value - mean
    m2 += delta * delta2
    return count, mean, m2


async def ingest_realm_auctions(
    client: BlizzardClient,
    session_factory,
    connected_realm_id: int,
    settings,
) -> tuple[int, set[int]]:
    """
    Ingest auctions for a single connected realm.
    UPSERTs aggregated stats into item_realm_aggregates.

    Returns: (auction_count, set_of_item_ids_seen)
    """
    now = datetime.now(timezone.utc)

    try:
        data = await client.get_auctions(connected_realm_id)
    except Exception as e:
        logger.error("Failed to fetch auctions for realm %d: %s", connected_realm_id, e)
        async with session_factory() as session:
            snapshot = Snapshot(
                region=settings.region,
                connected_realm_id=connected_realm_id,
                fetched_at=now,
                status="failed",
                error=str(e),
            )
            session.add(snapshot)
            await session.commit()
        return 0, set()

    if data is NOT_MODIFIED:
        logger.info("Realm %d: 304 Not Modified, skipping", connected_realm_id)
        return 0, set()

    auctions = data.get("auctions", [])
    logger.info("Realm %d: %d auctions fetched", connected_realm_id, len(auctions))

    # Aggregate per-item stats
    item_stats = compute_buyout_stats(auctions)
    item_ids = set(item_stats.keys())

    async with session_factory() as session:
        # Get previous aggregate data for this realm to compute demand proxy
        stmt = (
            select(ItemRealmAggregate)
            .where(ItemRealmAggregate.region == settings.region)
            .where(ItemRealmAggregate.connected_realm_id == connected_realm_id)
        )
        result = await session.execute(stmt)
        existing_aggregates = {row.item_id: row for row in result.scalars().all()}

        # Get previous snapshot time for this realm
        prev_snapshot_stmt = (
            select(Snapshot.fetched_at)
            .where(Snapshot.connected_realm_id == connected_realm_id)
            .where(Snapshot.status == "success")
            .order_by(Snapshot.fetched_at.desc())
            .limit(1)
        )
        prev_result = await session.execute(prev_snapshot_stmt)
        prev_time = prev_result.scalar_one_or_none()

        dt_hours = 1.0
        if prev_time:
            if prev_time.tzinfo is None:
                prev_time = prev_time.replace(tzinfo=timezone.utc)
            delta = (now - prev_time).total_seconds() / 3600.0
            dt_hours = max(delta, 0.01)

        # Record snapshot metadata
        snapshot = Snapshot(
            region=settings.region,
            connected_realm_id=connected_realm_id,
            fetched_at=now,
            auction_count=len(auctions),
            status="success",
        )
        session.add(snapshot)
        await session.flush()

        # Build all aggregate rows in Python first, then batch UPSERT
        rows_to_upsert = []
        daily_rows = []
        today = now.date()
        for item_id, stats in item_stats.items():
            prev_agg = existing_aggregates.get(item_id)

            # Previous values for demand proxy
            prev_qty = prev_agg.total_quantity if prev_agg else 0
            prev_listings = prev_agg.listing_count if prev_agg else 0
            prev_smoothed = prev_agg.demand_proxy_smoothed if prev_agg else 0.0

            # Compute demand proxy
            raw_demand, smoothed_demand = compute_demand_proxy(
                current_qty=stats["total_quantity"],
                prev_qty=prev_qty,
                current_listings=stats["listing_count"],
                prev_listings=prev_listings,
                dt_hours=dt_hours,
                prev_smoothed=prev_smoothed,
                alpha=settings.ewma_alpha,
            )

            current_price = float(stats["median_buyout"] or 0)

            # EWMA update
            prev_ewma_price = prev_agg.ewma_price if prev_agg else current_price
            prev_ewma_demand = prev_agg.ewma_demand if prev_agg else smoothed_demand
            new_ewma_price = settings.ewma_alpha * current_price + (1 - settings.ewma_alpha) * (prev_ewma_price or current_price)
            new_ewma_demand = settings.ewma_alpha * smoothed_demand + (1 - settings.ewma_alpha) * (prev_ewma_demand or smoothed_demand)

            # Welford update
            prev_count = prev_agg.snapshot_count if prev_agg else 0
            prev_price_mean = prev_agg.price_mean if prev_agg else 0.0
            prev_price_m2 = prev_agg.price_m2 if prev_agg else 0.0
            prev_demand_mean = prev_agg.demand_mean if prev_agg else 0.0
            prev_demand_m2 = prev_agg.demand_m2 if prev_agg else 0.0

            new_count, new_price_mean, new_price_m2 = welford_update(
                prev_count, prev_price_mean, prev_price_m2, current_price
            )
            _, new_demand_mean, new_demand_m2 = welford_update(
                prev_count, prev_demand_mean, prev_demand_m2, smoothed_demand
            )

            rows_to_upsert.append({
                "p_region": settings.region,
                "p_cr_id": connected_realm_id,
                "p_item_id": item_id,
                "p_listing_count": stats["listing_count"],
                "p_total_quantity": stats["total_quantity"],
                "p_min_buyout": stats["min_buyout"],
                "p_median_buyout": stats["median_buyout"],
                "p_mean_buyout": stats["mean_buyout"],
                "p_vwap_buyout": stats["vwap_buyout"],
                "p_ewma_price": new_ewma_price,
                "p_ewma_demand": new_ewma_demand,
                "p_demand_raw": raw_demand,
                "p_demand_smoothed": smoothed_demand,
                "p_price_mean": new_price_mean,
                "p_price_m2": new_price_m2,
                "p_demand_mean": new_demand_mean,
                "p_demand_m2": new_demand_m2,
                "p_snap_count": new_count,
                "p_updated_at": now,
            })

            # Daily summary row (latest values for today)
            daily_rows.append({
                "p_region": settings.region,
                "p_cr_id": connected_realm_id,
                "p_item_id": item_id,
                "p_date": today,
                "p_median_price": stats["median_buyout"],
                "p_demand": smoothed_demand,
                "p_listing_count": stats["listing_count"],
                "p_total_quantity": stats["total_quantity"],
            })

        # Batch UPSERT using raw SQL for performance
        if rows_to_upsert:
            upsert_sql = text("""
                INSERT INTO item_realm_aggregates (
                    region, connected_realm_id, item_id,
                    listing_count, total_quantity, min_buyout, median_buyout,
                    mean_buyout, vwap_buyout, ewma_price, ewma_demand,
                    demand_proxy_raw, demand_proxy_smoothed,
                    price_mean, price_m2, demand_mean, demand_m2,
                    snapshot_count, updated_at
                ) VALUES (
                    :p_region, :p_cr_id, :p_item_id,
                    :p_listing_count, :p_total_quantity, :p_min_buyout, :p_median_buyout,
                    :p_mean_buyout, :p_vwap_buyout, :p_ewma_price, :p_ewma_demand,
                    :p_demand_raw, :p_demand_smoothed,
                    :p_price_mean, :p_price_m2, :p_demand_mean, :p_demand_m2,
                    :p_snap_count, :p_updated_at
                )
                ON CONFLICT (region, connected_realm_id, item_id) DO UPDATE SET
                    listing_count = EXCLUDED.listing_count,
                    total_quantity = EXCLUDED.total_quantity,
                    min_buyout = EXCLUDED.min_buyout,
                    median_buyout = EXCLUDED.median_buyout,
                    mean_buyout = EXCLUDED.mean_buyout,
                    vwap_buyout = EXCLUDED.vwap_buyout,
                    ewma_price = EXCLUDED.ewma_price,
                    ewma_demand = EXCLUDED.ewma_demand,
                    demand_proxy_raw = EXCLUDED.demand_proxy_raw,
                    demand_proxy_smoothed = EXCLUDED.demand_proxy_smoothed,
                    price_mean = EXCLUDED.price_mean,
                    price_m2 = EXCLUDED.price_m2,
                    demand_mean = EXCLUDED.demand_mean,
                    demand_m2 = EXCLUDED.demand_m2,
                    snapshot_count = EXCLUDED.snapshot_count,
                    updated_at = EXCLUDED.updated_at
            """)
            # Execute in batches of 500
            for batch_start in range(0, len(rows_to_upsert), 500):
                batch = rows_to_upsert[batch_start:batch_start + 500]
                await session.execute(upsert_sql, batch)

        # --- Daily summary UPSERT (lightweight time-series) ---
        if daily_rows:
            daily_sql = text("""
                INSERT INTO item_realm_daily (
                    region, connected_realm_id, item_id, date,
                    median_price, demand_proxy, listing_count, total_quantity
                ) VALUES (
                    :p_region, :p_cr_id, :p_item_id, :p_date,
                    :p_median_price, :p_demand, :p_listing_count, :p_total_quantity
                )
                ON CONFLICT (region, connected_realm_id, item_id, date) DO UPDATE SET
                    median_price = EXCLUDED.median_price,
                    demand_proxy = EXCLUDED.demand_proxy,
                    listing_count = EXCLUDED.listing_count,
                    total_quantity = EXCLUDED.total_quantity
            """)
            for batch_start in range(0, len(daily_rows), 500):
                batch = daily_rows[batch_start:batch_start + 500]
                await session.execute(daily_sql, batch)

        await session.commit()

    return len(auctions), item_ids


async def queue_unresolved_items(session_factory, item_ids: set[int]):
    """Upsert item_metadata_status for newly seen items."""
    if not item_ids:
        return

    async with session_factory() as session:
        for batch_start in range(0, len(item_ids), 500):
            batch = list(item_ids)[batch_start : batch_start + 500]
            for item_id in batch:
                stmt = pg_insert(ItemMetadataStatus.__table__).values(
                    item_id=item_id,
                    status="pending",
                    attempts=0,
                ).on_conflict_do_nothing(index_elements=["item_id"])
                await session.execute(stmt)
            await session.commit()

    logger.info("Queued %d item IDs for metadata resolution", len(item_ids))


async def run_ingest():
    """Main ingest job entry point."""
    settings = get_settings()
    logger.info(
        "Starting ingest job for region=%s, namespace=%s",
        settings.region,
        settings.namespace_dynamic,
    )

    t0 = time.monotonic()
    await ensure_tables()

    redis = None
    try:
        redis = await get_redis()
    except Exception:
        logger.warning("Redis not available, running without ETag cache")

    client = BlizzardClient(settings=settings, redis=redis)
    session_factory = get_async_session_factory()

    try:
        # Step 1: Ingest realm index
        connected_realm_ids = await ingest_realms(client, session_factory)
        logger.info("Processing %d connected realms", len(connected_realm_ids))

        # Step 2: Fetch auctions for each realm sequentially
        total_auctions = 0
        all_item_ids: set[int] = set()
        success_count = 0
        fail_count = 0

        for i, cr_id in enumerate(connected_realm_ids):
            logger.info(
                "Ingesting realm %d/%d (ID: %d)",
                i + 1,
                len(connected_realm_ids),
                cr_id,
            )
            try:
                count, item_ids = await ingest_realm_auctions(
                    client, session_factory, cr_id, settings
                )
                total_auctions += count
                all_item_ids.update(item_ids)
                success_count += 1
            except Exception as e:
                logger.error("Failed realm %d: %s", cr_id, e)
                fail_count += 1
                continue

        # Step 3: Queue unresolved items for metadata
        await queue_unresolved_items(session_factory, all_item_ids)

        elapsed = time.monotonic() - t0
        metrics = client.get_metrics()
        logger.info(
            "Ingest complete: %d realms (%d success, %d failed), "
            "%d total auctions, %d unique items, %.1fs elapsed. "
            "API metrics: %s",
            len(connected_realm_ids),
            success_count,
            fail_count,
            total_auctions,
            len(all_item_ids),
            elapsed,
            metrics,
        )

    finally:
        await client.close()
        await close_redis()


if __name__ == "__main__":
    asyncio.run(run_ingest())
