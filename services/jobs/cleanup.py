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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("cleanup")

# Keep this many snapshots per realm (metadata only, for tracking)
MAX_SNAPSHOTS_TO_KEEP = 10


async def run_cleanup():
    """Drop old tables, prune snapshots, and VACUUM."""
    settings = get_settings()
    engine = get_async_engine()
    t0 = time.monotonic()

    async with engine.begin() as conn:
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

    # VACUUM to reclaim disk space (needs autocommit)
    from sqlalchemy import create_engine
    sync_engine = create_engine(settings.database_url_sync, isolation_level="AUTOCOMMIT")
    with sync_engine.connect() as conn:
        logger.info("Running VACUUM...")
        conn.execute(text("VACUUM"))

        result = conn.execute(text("SELECT pg_size_pretty(pg_database_size(current_database()))"))
        logger.info("Database size after cleanup: %s", result.scalar())

    sync_engine.dispose()
    await engine.dispose()

    elapsed = time.monotonic() - t0
    logger.info("Cleanup complete in %.1fs", elapsed)


if __name__ == "__main__":
    asyncio.run(run_cleanup())
