"""
Database cleanup script -- drops old snapshot metrics table and VACUUMs.

Also prunes old snapshot records to keep metadata only for recent history.

Usage: python -m services.jobs.cleanup
"""

import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import text
from packages.shared.config import get_settings
from packages.shared.db import get_async_engine
from packages.shared.models import Base

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("cleanup")

# Keep this many snapshots per realm (metadata only, for tracking)
MAX_SNAPSHOTS_TO_KEEP = 10

# Keep this many days of item_realm_daily history (UI charts at most 90 days)
MAX_DAILY_HISTORY_DAYS = 90

# Indexes required by the web API's hot paths. Created here idempotently since
# Base.metadata.create_all only creates indexes for brand-new tables.
REQUIRED_INDEXES = [
    # /api/hot + /api/item count/look up aggregates by (region, item_id);
    # without this every lookup scans the whole ~1.5M-row region partition.
    "CREATE INDEX IF NOT EXISTS ix_aggregates_region_item ON item_realm_aggregates(region, item_id)",
    # Supports the daily-history pruning below.
    "CREATE INDEX IF NOT EXISTS ix_daily_date ON item_realm_daily(date)",
    # Schema evolution (create_all only creates missing tables, not columns)
    "ALTER TABLE IF EXISTS recipe_market ADD COLUMN IF NOT EXISTS demand_per_day DOUBLE PRECISION DEFAULT 0",
    # Listing-age mix + auction-flow columns (2026-07 batch)
    "ALTER TABLE IF EXISTS item_realm_aggregates ADD COLUMN IF NOT EXISTS tl_short INTEGER",
    "ALTER TABLE IF EXISTS item_realm_aggregates ADD COLUMN IF NOT EXISTS tl_medium INTEGER",
    "ALTER TABLE IF EXISTS item_realm_aggregates ADD COLUMN IF NOT EXISTS tl_long INTEGER",
    "ALTER TABLE IF EXISTS item_realm_aggregates ADD COLUMN IF NOT EXISTS tl_very_long INTEGER",
    "ALTER TABLE IF EXISTS item_realm_features_latest ADD COLUMN IF NOT EXISTS removals_per_day DOUBLE PRECISION",
    "ALTER TABLE IF EXISTS item_realm_features_latest ADD COLUMN IF NOT EXISTS tl_short INTEGER",
    "ALTER TABLE IF EXISTS item_realm_features_latest ADD COLUMN IF NOT EXISTS tl_medium INTEGER",
    "ALTER TABLE IF EXISTS item_realm_features_latest ADD COLUMN IF NOT EXISTS tl_long INTEGER",
    "ALTER TABLE IF EXISTS item_realm_features_latest ADD COLUMN IF NOT EXISTS tl_very_long INTEGER",
]


async def run_cleanup():
    """Ensure indexes, drop old tables, prune snapshots + daily history, and VACUUM."""
    settings = get_settings()
    engine = get_async_engine()
    t0 = time.monotonic()

    # Cleanup runs FIRST in the pipeline: create any missing tables so
    # prunes/DDL below never race schema creation (idempotent, cheap).
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with engine.begin() as conn:
        # Ensure hot-path indexes exist (no-op when already present)
        for ddl in REQUIRED_INDEXES:
            await conn.execute(text(ddl))
        # Drop old metrics table if it exists (massive space saver)
        result = await conn.execute(text(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'item_realm_snapshot_metrics')"
        ))
        old_table_exists = result.scalar()

        if old_table_exists:
            logger.info("Dropping old item_realm_snapshot_metrics table...")
            await conn.execute(text("DROP TABLE item_realm_snapshot_metrics"))
            logger.info("Dropped item_realm_snapshot_metrics")

        # Prune old snapshot records (keep most recent N per realm)
        result = await conn.execute(text("SELECT count(*) FROM snapshots"))
        before_snapshots = result.scalar()

        delete_snapshots = text("""
            DELETE FROM snapshots
            WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY connected_realm_id
                               ORDER BY fetched_at DESC
                           ) AS rn
                    FROM snapshots
                ) ranked
                WHERE rn <= :max_keep
            )
        """)
        result = await conn.execute(delete_snapshots, {"max_keep": MAX_SNAPSHOTS_TO_KEEP})
        deleted_snapshots = result.rowcount

        result = await conn.execute(text("SELECT count(*) FROM snapshots"))
        after_snapshots = result.scalar()

        logger.info(
            "Snapshot cleanup: %d -> %d (%d deleted)",
            before_snapshots, after_snapshots, deleted_snapshots,
        )

        # Prune auction-flow history (90 days, same policy as daily prices)
        result = await conn.execute(
            text(
                "DELETE FROM auction_flow_daily "
                f"WHERE date < CURRENT_DATE - {int(MAX_DAILY_HISTORY_DAYS)}"
            )
        )
        logger.info("Auction-flow cleanup: %d rows deleted", result.rowcount)

        # Prune old daily history rows (table otherwise grows without bound).
        # NOTE: constant is inlined — SQLAlchemy text() does not parse a bind
        # param immediately followed by a ::cast (":days::int" reaches Postgres raw).
        result = await conn.execute(
            text(
                "DELETE FROM item_realm_daily "
                f"WHERE date < CURRENT_DATE - {int(MAX_DAILY_HISTORY_DAYS)}"
            )
        )
        logger.info("Daily history cleanup: %d rows older than %d days deleted",
                    result.rowcount, MAX_DAILY_HISTORY_DAYS)

        # Prune aggregates/daily rows for items outside the relevant universe
        # (classified as neither Decor, craftable, nor reagent). Guarded on the
        # recipe catalog being populated — before that, craftables/reagents
        # can't be distinguished from irrelevant items.
        recipe_count = (await conn.execute(text("SELECT COUNT(*) FROM recipes"))).scalar()
        if recipe_count and recipe_count > 0:
            irrelevant_filter = """
                USING items i
                WHERE {alias}.item_id = i.id
                  AND i.item_subclass IS NOT NULL
                  AND i.item_subclass != 'Decor'
                  AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.crafted_item_id = {alias}.item_id)
                  AND NOT EXISTS (SELECT 1 FROM recipe_reagents rr WHERE rr.reagent_item_id = {alias}.item_id)
            """
            result = await conn.execute(text(
                "DELETE FROM item_realm_aggregates a " + irrelevant_filter.format(alias="a")
            ))
            logger.info("Universe prune: %d irrelevant aggregate rows deleted", result.rowcount)
            result = await conn.execute(text(
                "DELETE FROM item_realm_daily d " + irrelevant_filter.format(alias="d")
            ))
            logger.info("Universe prune: %d irrelevant daily rows deleted", result.rowcount)
        else:
            logger.info("Universe prune skipped: recipe catalog not yet populated")

    # VACUUM to reclaim disk space (needs autocommit). Strictly best-effort:
    # a whole-DB VACUUM right after multi-million-row deletes crashed the
    # t4g.micro backend once — vacuum per table, and NEVER let a vacuum
    # failure abort the workflow (ingest/compute must still run; autovacuum
    # will catch up regardless).
    from sqlalchemy import create_engine
    sync_engine = create_engine(settings.database_url_sync, isolation_level="AUTOCOMMIT")
    vacuum_tables = [
        "snapshots",
        "item_realm_features_latest",
        "item_realm_aggregates",
        "item_realm_daily",
        "live_auctions",
        "auction_flow_daily",
    ]
    try:
        with sync_engine.connect() as conn:
            for table in vacuum_tables:
                try:
                    logger.info("VACUUM (ANALYZE) %s...", table)
                    # ANALYZE keeps planner stats current — after mass deletes,
                    # stale stats caused seq-scan plans and API timeouts
                    conn.execute(text(f"VACUUM (ANALYZE) {table}"))
                except Exception as e:
                    logger.warning("VACUUM %s failed (non-fatal): %s", table, e)
            result = conn.execute(text("SELECT pg_size_pretty(pg_database_size(current_database()))"))
            logger.info("Database size after cleanup: %s", result.scalar())
    except Exception as e:
        logger.warning("VACUUM phase failed (non-fatal): %s", e)

    sync_engine.dispose()
    await engine.dispose()

    elapsed = time.monotonic() - t0
    logger.info("Cleanup complete in %.1fs", elapsed)


if __name__ == "__main__":
    asyncio.run(run_cleanup())
