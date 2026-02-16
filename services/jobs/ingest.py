"""
Ingest Job -- Fetches auction data from Blizzard API and computes demand proxy.

This job:
1. Fetches the connected realm index and upserts realm records.
2. For each connected realm, fetches auction listings (with ETag caching).
3. Aggregates per-item metrics: listing_count, total_quantity, buyout stats.
4. Computes demand proxy via snapshot churn (normalized_churn + EWMA).
5. Queues unresolved item IDs for metadata resolution.

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
    ItemRealmSnapshotMetric,
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
    # href looks like "https://us.api.blizzard.com/data/wow/connected-realm/1136?namespace=dynamic-us"
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
    - min/median/mean/p10/p90 buyout (unit price)
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
            "p10_buyout": int(np.percentile(buyouts, 10)) if buyouts else None,
            "p90_buyout": int(np.percentile(buyouts, 90)) if buyouts else None,
            "vwap_buyout": int(total_value / max(total_qty, 1)),
        }

    return result


async def get_previous_metrics(
    session, connected_realm_id: int
) -> dict[int, tuple[int, int, float]]:
    """
    Get the most recent metrics for each item in this connected realm.
    Returns: {item_id: (total_quantity, listing_count, demand_proxy_smoothed)}
    """
    # Get the most recent snapshot for this realm
    stmt = (
        select(Snapshot.id)
        .where(Snapshot.connected_realm_id == connected_realm_id)
        .where(Snapshot.status == "success")
        .order_by(Snapshot.fetched_at.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    prev_snapshot_id = result.scalar_one_or_none()

    if prev_snapshot_id is None:
        return {}

    stmt = select(
        ItemRealmSnapshotMetric.item_id,
        ItemRealmSnapshotMetric.total_quantity,
        ItemRealmSnapshotMetric.listing_count,
        ItemRealmSnapshotMetric.demand_proxy_smoothed,
    ).where(ItemRealmSnapshotMetric.snapshot_id == prev_snapshot_id)

    result = await session.execute(stmt)
    return {
        row.item_id: (row.total_quantity, row.listing_count, row.demand_proxy_smoothed or 0.0)
        for row in result
    }


async def get_previous_snapshot_time(
    session, connected_realm_id: int
) -> datetime | None:
    """Get the fetch time of the most recent snapshot for this realm."""
    stmt = (
        select(Snapshot.fetched_at)
        .where(Snapshot.connected_realm_id == connected_realm_id)
        .where(Snapshot.status == "success")
        .order_by(Snapshot.fetched_at.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


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

    If quantity increases (replenishment), churn = 0.

    Returns: (demand_proxy_raw, demand_proxy_smoothed)
    """
    eps = 0.01

    # Raw churn (quantity decrease normalized by previous quantity and time)
    churn_qty = max(0, prev_qty - current_qty)
    normalized_churn = churn_qty / max(prev_qty, 1) / max(dt_hours, eps)

    # EWMA smoothing
    smoothed = alpha * normalized_churn + (1 - alpha) * prev_smoothed

    return normalized_churn, smoothed


async def ingest_realm_auctions(
    client: BlizzardClient,
    session_factory,
    connected_realm_id: int,
    settings,
) -> tuple[int, set[int]]:
    """
    Ingest auctions for a single connected realm.

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
        # Get previous snapshot data for demand proxy
        prev_metrics = await get_previous_metrics(session, connected_realm_id)
        prev_time = await get_previous_snapshot_time(session, connected_realm_id)

        dt_hours = 1.0  # default
        if prev_time:
            if prev_time.tzinfo is None:
                from datetime import timezone as tz
                prev_time = prev_time.replace(tzinfo=tz.utc)
            delta = (now - prev_time).total_seconds() / 3600.0
            dt_hours = max(delta, 0.01)

        # Create snapshot record
        snapshot = Snapshot(
            region=settings.region,
            connected_realm_id=connected_realm_id,
            fetched_at=now,
            auction_count=len(auctions),
            status="success",
        )
        session.add(snapshot)
        await session.flush()  # Get snapshot.id

        # Insert per-item metrics
        metrics_to_insert = []
        for item_id, stats in item_stats.items():
            prev = prev_metrics.get(item_id, (0, 0, 0.0))
            prev_qty, prev_listings, prev_smoothed = prev

            raw, smoothed = compute_demand_proxy(
                current_qty=stats["total_quantity"],
                prev_qty=prev_qty,
                current_listings=stats["listing_count"],
                prev_listings=prev_listings,
                dt_hours=dt_hours,
                prev_smoothed=prev_smoothed,
                alpha=settings.ewma_alpha,
            )

            metrics_to_insert.append({
                "snapshot_id": snapshot.id,
                "item_id": item_id,
                "connected_realm_id": connected_realm_id,
                "listing_count": stats["listing_count"],
                "total_quantity": stats["total_quantity"],
                "min_buyout": stats["min_buyout"],
                "median_buyout": stats["median_buyout"],
                "mean_buyout": stats["mean_buyout"],
                "p10_buyout": stats["p10_buyout"],
                "p90_buyout": stats["p90_buyout"],
                "vwap_buyout": stats["vwap_buyout"],
                "demand_proxy_raw": raw,
                "demand_proxy_smoothed": smoothed,
            })

        # Bulk insert metrics
        if metrics_to_insert:
            await session.execute(
                ItemRealmSnapshotMetric.__table__.insert(),
                metrics_to_insert,
            )

        await session.commit()

    return len(auctions), item_ids


async def queue_unresolved_items(session_factory, item_ids: set[int]):
    """Upsert item_metadata_status for newly seen items."""
    if not item_ids:
        return

    async with session_factory() as session:
        # Batch upsert -- only insert if not already tracked
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

        # Step 2: Fetch auctions for each realm sequentially (respects rate limits)
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
