"""
Item Metadata Resolver Job -- Fetches item names, quality, icons from Blizzard API.

This job:
1. Queries item_metadata_status for pending/failed items.
2. Prioritizes by: hot list items > high listing count > long tail.
3. Fetches item data and media with strict rate limiting.
4. Uses distributed locks (Redis) to deduplicate concurrent fetches.
5. Implements circuit breaker when 429 rate exceeds threshold.

Design rationale (see docs/ADR/0002-item-metadata-pipeline.md):
- Never fetch metadata in the web request path.
- Resolve asynchronously with aggressive dedup.
- UI functions with missing metadata (shows item_id + placeholder).

Run: python -m services.jobs.meta_resolve
"""

import asyncio
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, func, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from packages.shared.blizzard_client import BlizzardClient
from packages.shared.config import get_settings
from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import (
    Base,
    Item,
    ItemMedia,
    ItemMetadataStatus,
    ItemRealmFeaturesLatest,
)
from packages.shared.redis_client import DistributedLock, get_redis, close_redis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("meta_resolve")


class CircuitBreaker:
    """Simple circuit breaker -- opens when 429 count exceeds threshold in window."""

    def __init__(self, threshold: int = 10, window_seconds: int = 60, cooldown_seconds: int = 30):
        self.threshold = threshold
        self.window_seconds = window_seconds
        self.cooldown_seconds = cooldown_seconds
        self._hits: list[float] = []
        self._open_until: float = 0

    def record_429(self):
        now = time.monotonic()
        self._hits.append(now)
        # Prune old hits
        cutoff = now - self.window_seconds
        self._hits = [h for h in self._hits if h > cutoff]

        if len(self._hits) >= self.threshold:
            self._open_until = now + self.cooldown_seconds
            logger.warning(
                "Circuit breaker OPEN: %d 429s in %ds, cooling down %ds",
                len(self._hits),
                self.window_seconds,
                self.cooldown_seconds,
            )

    def is_open(self) -> bool:
        return time.monotonic() < self._open_until

    async def wait_if_open(self):
        if self.is_open():
            wait_time = self._open_until - time.monotonic()
            if wait_time > 0:
                logger.info("Circuit breaker: waiting %.1fs", wait_time)
                await asyncio.sleep(wait_time)


async def get_priority_item_ids(session, limit: int = 2000) -> list[int]:
    """
    Get item IDs to resolve, prioritized by:
    1. Items in the hot list (highest hotness_score)
    2. Items with highest total listing count
    3. Remaining pending items
    """
    settings = get_settings()

    # Priority 1: Items in features table (hot items)
    hot_items_stmt = (
        select(ItemRealmFeaturesLatest.item_id)
        .where(ItemRealmFeaturesLatest.region == settings.region)
        .order_by(ItemRealmFeaturesLatest.hotness_score.desc())
        .limit(500)
    )
    result = await session.execute(hot_items_stmt)
    hot_item_ids = [row[0] for row in result]

    # Get all pending/failed items
    pending_stmt = (
        select(ItemMetadataStatus.item_id)
        .where(ItemMetadataStatus.status.in_(["pending", "failed"]))
        .where(ItemMetadataStatus.attempts < 5)  # give up after 5 attempts
        .limit(limit)
    )
    result = await session.execute(pending_stmt)
    all_pending = [row[0] for row in result]

    # Prioritize: hot items first, then remaining
    hot_set = set(hot_item_ids)
    prioritized = [iid for iid in all_pending if iid in hot_set]
    remaining = [iid for iid in all_pending if iid not in hot_set]
    prioritized.extend(remaining)

    return prioritized[:limit]


async def resolve_item(
    client: BlizzardClient,
    session_factory,
    redis,
    item_id: int,
    circuit_breaker: CircuitBreaker,
) -> bool:
    """
    Resolve metadata for a single item.

    Returns True if resolved successfully, False otherwise.
    """
    # Check circuit breaker
    await circuit_breaker.wait_if_open()

    # Distributed lock to prevent concurrent resolution of same item
    if redis:
        lock = DistributedLock(redis, f"item_meta:{item_id}", ttl=30)
        acquired = await lock.acquire()
        if not acquired:
            logger.debug("Item %d: lock held by another worker, skipping", item_id)
            return False
    else:
        lock = None

    now = datetime.now(timezone.utc)

    try:
        # Check Redis cache first
        if redis:
            cached = await redis.get(f"item:{item_id}")
            if cached:
                logger.debug("Item %d: found in Redis cache", item_id)
                return True

        # Fetch item metadata
        try:
            item_data = await client.get_item(item_id)
        except Exception as e:
            error_str = str(e)
            if "429" in error_str:
                circuit_breaker.record_429()

            async with session_factory() as session:
                stmt = (
                    update(ItemMetadataStatus.__table__)
                    .where(ItemMetadataStatus.item_id == item_id)
                    .values(
                        status="failed",
                        attempts=ItemMetadataStatus.attempts + 1,
                        last_attempt_at=now,
                        last_error=error_str[:500],
                        updated_at=now,
                    )
                )
                await session.execute(stmt)
                await session.commit()
            return False

        # Parse item data
        name = item_data.get("name", {})
        if isinstance(name, dict):
            name = name.get(get_settings().locale, name.get("en_US", ""))
        quality_data = item_data.get("quality", {})
        quality = quality_data.get("type", "") if isinstance(quality_data, dict) else str(quality_data)
        level = item_data.get("level")
        item_class_data = item_data.get("item_class", {})
        item_class = item_class_data.get("name", "") if isinstance(item_class_data, dict) else ""
        if isinstance(item_class, dict):
            item_class = item_class.get(get_settings().locale, item_class.get("en_US", ""))
        item_subclass_data = item_data.get("item_subclass", {})
        item_subclass = item_subclass_data.get("name", "") if isinstance(item_subclass_data, dict) else ""
        if isinstance(item_subclass, dict):
            item_subclass = item_subclass.get(get_settings().locale, item_subclass.get("en_US", ""))

        # Fetch item media (icon)
        icon_url = None
        try:
            media_data = await client.get_item_media(item_id)
            assets = media_data.get("assets", [])
            for asset in assets:
                if asset.get("key") == "icon":
                    icon_url = asset.get("value")
                    break
        except Exception as e:
            logger.debug("Failed to fetch media for item %d: %s", item_id, e)

        # Upsert into items table
        async with session_factory() as session:
            stmt = pg_insert(Item.__table__).values(
                id=item_id,
                name=str(name) if name else None,
                quality=str(quality) if quality else None,
                level=level,
                item_class=str(item_class) if item_class else None,
                item_subclass=str(item_subclass) if item_subclass else None,
                required_level=item_data.get("required_level"),
                max_count=item_data.get("max_count"),
                is_equippable=str(item_data.get("is_equippable", "")),
                is_stackable=str(item_data.get("is_stackable", "")),
                purchase_price=item_data.get("purchase_price"),
                sell_price=item_data.get("sell_price"),
                last_resolved_at=now,
                updated_at=now,
            ).on_conflict_do_update(
                index_elements=["id"],
                set_={
                    "name": str(name) if name else None,
                    "quality": str(quality) if quality else None,
                    "level": level,
                    "item_class": str(item_class) if item_class else None,
                    "item_subclass": str(item_subclass) if item_subclass else None,
                    "last_resolved_at": now,
                    "updated_at": now,
                },
            )
            await session.execute(stmt)

            # Upsert item media
            if icon_url:
                stmt = pg_insert(ItemMedia.__table__).values(
                    item_id=item_id,
                    icon_url=icon_url,
                    updated_at=now,
                ).on_conflict_do_update(
                    index_elements=["item_id"],
                    set_={
                        "icon_url": icon_url,
                        "updated_at": now,
                    },
                )
                await session.execute(stmt)

            # Update metadata status
            stmt = (
                update(ItemMetadataStatus.__table__)
                .where(ItemMetadataStatus.item_id == item_id)
                .values(
                    status="resolved",
                    last_attempt_at=now,
                    last_error=None,
                    updated_at=now,
                )
            )
            await session.execute(stmt)
            await session.commit()

        # Cache in Redis
        if redis:
            import json
            await redis.set(
                f"item:{item_id}",
                json.dumps({"name": str(name), "icon_url": icon_url}),
                ex=7 * 86400,  # 7 day TTL
            )

        logger.debug("Resolved item %d: %s", item_id, name)
        return True

    except Exception as e:
        logger.error("Unexpected error resolving item %d: %s", item_id, e)
        return False

    finally:
        if lock:
            try:
                await lock.release()
            except Exception:
                pass


async def run_meta_resolve():
    """Main metadata resolver job entry point."""
    settings = get_settings()
    logger.info("Starting metadata resolver job, concurrency=%d", settings.meta_resolve_concurrent)

    t0 = time.monotonic()
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    redis = None
    try:
        redis = await get_redis()
    except Exception:
        logger.warning("Redis not available, running without distributed locks")

    client = BlizzardClient(settings=settings, redis=redis)
    session_factory = get_async_session_factory()
    circuit_breaker = CircuitBreaker(threshold=10, window_seconds=60, cooldown_seconds=30)

    try:
        async with session_factory() as session:
            item_ids = await get_priority_item_ids(session, limit=2000)

        if not item_ids:
            logger.info("No items to resolve")
            return

        logger.info("Resolving metadata for %d items", len(item_ids))

        # Process with bounded concurrency
        semaphore = asyncio.Semaphore(settings.meta_resolve_concurrent)
        resolved = 0
        failed = 0

        async def resolve_with_semaphore(item_id: int):
            nonlocal resolved, failed
            async with semaphore:
                success = await resolve_item(
                    client, session_factory, redis, item_id, circuit_breaker
                )
                if success:
                    resolved += 1
                else:
                    failed += 1

        # Process in batches of 100 to manage memory
        for batch_start in range(0, len(item_ids), 100):
            batch = item_ids[batch_start : batch_start + 100]
            await asyncio.gather(
                *[resolve_with_semaphore(iid) for iid in batch],
                return_exceptions=True,
            )
            logger.info(
                "Progress: %d/%d items processed (%d resolved, %d failed)",
                min(batch_start + 100, len(item_ids)),
                len(item_ids),
                resolved,
                failed,
            )

        elapsed = time.monotonic() - t0
        metrics = client.get_metrics()
        logger.info(
            "Metadata resolver complete: %d resolved, %d failed, %.1fs elapsed. "
            "API metrics: %s",
            resolved,
            failed,
            elapsed,
            metrics,
        )

    finally:
        await client.close()
        await close_redis()


if __name__ == "__main__":
    asyncio.run(run_meta_resolve())
