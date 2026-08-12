"""Import converted AH scan files (data/ah_scans/*.v1.json) into auction_owners.

Idempotent: filenames already recorded in scan_imports are skipped, and rows
upsert on (region, connected_realm_id, auction_id). Realm names from the game
client are matched against the realms table; a scan whose realm can't be
resolved is skipped loudly rather than guessed.

Run:  python -m services.jobs.scan_import
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

from packages.shared.config import get_settings
from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import Base

logger = logging.getLogger("scan_import")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

SCAN_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "ah_scans"


async def run_import() -> None:
    settings = get_settings()
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    files = sorted(SCAN_DIR.glob("*.v1.json")) if SCAN_DIR.exists() else []
    if not files:
        logger.info("No scan files in %s — nothing to import", SCAN_DIR)
        return

    factory = get_async_session_factory()
    async with factory() as session:
        imported = {
            row[0] for row in await session.execute(text("SELECT filename FROM scan_imports"))
        }
        realm_rows = await session.execute(text(
            "SELECT LOWER(name), connected_realm_id FROM realms"
        ))
        realm_map = {name: cr for name, cr in realm_rows}

        for path in files:
            if path.name in imported:
                logger.info("%s: already imported, skipping", path.name)
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("format") != "ftt-ah-scan" or data.get("version") != 1:
                logger.warning("%s: unknown format, skipping", path.name)
                continue
            region = str(data.get("region", "")).lower()
            if region not in ("?", settings.region):
                logger.warning("%s: region %r != %r, skipping", path.name, region, settings.region)
                continue
            realm_name = str(data.get("realm", "")).lower()
            cr_id = realm_map.get(realm_name)
            if cr_id is None:
                logger.warning("%s: realm %r not found in realms table, skipping",
                               path.name, data.get("realm"))
                continue
            scanned_at = datetime.fromisoformat(data["scanned_at"])
            if scanned_at.tzinfo is None:
                scanned_at = scanned_at.replace(tzinfo=timezone.utc)

            rows = data.get("rows") or []
            upsert = text("""
                INSERT INTO auction_owners (
                    region, connected_realm_id, auction_id, item_id,
                    seller, unit_price, quantity, scanned_at
                ) VALUES (:r, :cr, :aid, :item, :seller, :price, :qty, :ts)
                ON CONFLICT (region, connected_realm_id, auction_id) DO UPDATE SET
                    seller = EXCLUDED.seller,
                    unit_price = COALESCE(EXCLUDED.unit_price, auction_owners.unit_price),
                    scanned_at = GREATEST(auction_owners.scanned_at, EXCLUDED.scanned_at)
            """)
            batch = [{
                "r": settings.region, "cr": cr_id,
                "aid": row["auction_id"], "item": row["item_id"],
                "seller": row["seller"], "price": row.get("unit_price"),
                "qty": row.get("quantity", 1), "ts": scanned_at,
            } for row in rows]
            for start in range(0, len(batch), 500):
                await session.execute(upsert, batch[start:start + 500])
            await session.execute(text(
                "INSERT INTO scan_imports (filename, rows_imported, imported_at) "
                "VALUES (:f, :n, :ts) ON CONFLICT (filename) DO NOTHING"
            ), {"f": path.name, "n": len(batch), "ts": datetime.now(timezone.utc)})
            await session.commit()
            logger.info("%s: imported %d rows for %s (realm %d)",
                        path.name, len(batch), data.get("realm"), cr_id)


if __name__ == "__main__":
    asyncio.run(run_import())
