"""
Recipe Catalog Resolver Job -- Fetches profession recipes + reagents from Blizzard API.

This job:
1. Walks profession index -> professions -> skill tiers -> categories -> recipe IDs.
2. Fetches recipe details (crafted item, reagents, quantities) with rate limiting.
3. UPSERTs into recipes + recipe_reagents.
4. Queues crafted/reagent item IDs for metadata resolution (names/icons).

Incremental by default: only fetches recipes not already in the DB.
Set RECIPE_FULL_REFRESH=1 to refetch the entire catalog.

Static data — run on demand or monthly (see .github/workflows/recipes.yml).

Run: python -m services.jobs.recipe_resolve
"""

import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert

from packages.shared.blizzard_client import BlizzardClient
from packages.shared.config import get_settings
from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import (
    Base,
    ItemMetadataStatus,
    Recipe,
    RecipeReagent,
)
from packages.shared.redis_client import get_redis, close_redis

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("recipe_resolve")

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

RESOLVE_CONCURRENCY = 5


def _localized(value, locale: str) -> str | None:
    """Blizzard fields are either plain strings or {locale: str} dicts."""
    if isinstance(value, dict):
        return value.get(locale) or value.get("en_US")
    return value if value else None


async def discover_recipe_ids(client: BlizzardClient) -> dict[int, dict]:
    """
    Walk the profession catalog. Returns {recipe_id: context} where context
    carries profession/tier/category names for storage.
    """
    settings = get_settings()
    locale = settings.locale
    recipes: dict[int, dict] = {}

    professions = await client.get_profession_index()
    logger.info("Found %d professions", len(professions))

    for prof in professions:
        prof_id = prof.get("id")
        prof_name = _localized(prof.get("name"), locale)
        if prof_id is None:
            continue
        try:
            detail = await client.get_profession(prof_id)
        except Exception as e:
            logger.warning("Failed profession %s (%s): %s", prof_id, prof_name, e)
            continue

        tiers = detail.get("skill_tiers", [])
        for tier in tiers:
            tier_id = tier.get("id")
            tier_name = _localized(tier.get("name"), locale)
            if tier_id is None:
                continue
            try:
                tier_detail = await client.get_skill_tier(prof_id, tier_id)
            except Exception as e:
                logger.warning("Failed tier %s/%s: %s", prof_id, tier_id, e)
                continue

            for category in tier_detail.get("categories", []):
                cat_name = _localized(category.get("name"), locale)
                for r in category.get("recipes", []):
                    rid = r.get("id")
                    if rid is None:
                        continue
                    recipes[rid] = {
                        "profession_id": prof_id,
                        "profession_name": prof_name,
                        "skill_tier_id": tier_id,
                        "skill_tier_name": tier_name,
                        "category_name": cat_name,
                        "name": _localized(r.get("name"), locale),
                    }

    logger.info("Discovered %d recipes across the catalog", len(recipes))
    return recipes


async def resolve_recipe(
    client: BlizzardClient,
    session_factory,
    recipe_id: int,
    ctx: dict,
    item_ids_seen: set[int],
) -> bool:
    """Fetch one recipe's details and upsert recipe + reagents. Returns success."""
    now = datetime.now(timezone.utc)
    settings = get_settings()

    try:
        data = await client.get_recipe(recipe_id)
    except Exception as e:
        logger.warning("Failed recipe %d: %s", recipe_id, e)
        return False

    # Crafted item: neutral, or faction-specific fallback (either faction's
    # item id is fine for pricing — they're the same item economically)
    crafted = (
        data.get("crafted_item")
        or data.get("alliance_crafted_item")
        or data.get("horde_crafted_item")
    )
    crafted_item_id = crafted.get("id") if isinstance(crafted, dict) else None

    crafted_qty = data.get("crafted_quantity", {})
    if isinstance(crafted_qty, dict):
        # {"value": 1.0} or {"minimum": x, "maximum": y}
        crafted_quantity = crafted_qty.get("value")
        if crafted_quantity is None:
            lo, hi = crafted_qty.get("minimum"), crafted_qty.get("maximum")
            crafted_quantity = (lo + hi) / 2 if lo is not None and hi is not None else 1.0
    else:
        crafted_quantity = float(crafted_qty or 1.0)

    reagents = []
    for reagent in data.get("reagents", []):
        r_item = reagent.get("reagent", {})
        r_id = r_item.get("id")
        qty = reagent.get("quantity", 1)
        if r_id is not None:
            reagents.append({"recipe_id": recipe_id, "reagent_item_id": r_id, "quantity": qty})

    async with session_factory() as session:
        row = {
            "id": recipe_id,
            "name": _localized(data.get("name"), settings.locale) or ctx.get("name"),
            "profession_id": ctx["profession_id"],
            "profession_name": ctx.get("profession_name"),
            "skill_tier_id": ctx["skill_tier_id"],
            "skill_tier_name": ctx.get("skill_tier_name"),
            "category_name": ctx.get("category_name"),
            "crafted_item_id": crafted_item_id,
            "crafted_quantity": crafted_quantity,
            "updated_at": now,
        }
        stmt = pg_insert(Recipe.__table__).values(**row)
        stmt = stmt.on_conflict_do_update(
            index_elements=["id"],
            set_={k: v for k, v in row.items() if k != "id"},
        )
        await session.execute(stmt)

        # Replace reagent set (handles reagent changes between patches)
        await session.execute(
            delete(RecipeReagent.__table__).where(RecipeReagent.recipe_id == recipe_id)
        )
        if reagents:
            await session.execute(pg_insert(RecipeReagent.__table__).values(reagents))

        await session.commit()

    if crafted_item_id:
        item_ids_seen.add(crafted_item_id)
    item_ids_seen.update(r["reagent_item_id"] for r in reagents)
    return True


async def queue_item_metadata(session_factory, item_ids: set[int]):
    """Queue crafted/reagent items for name/icon resolution by meta_resolve."""
    if not item_ids:
        return
    async with session_factory() as session:
        ids = list(item_ids)
        for batch_start in range(0, len(ids), 500):
            batch = ids[batch_start : batch_start + 500]
            stmt = pg_insert(ItemMetadataStatus.__table__).values(
                [{"item_id": iid, "status": "pending", "attempts": 0} for iid in batch]
            ).on_conflict_do_nothing(index_elements=["item_id"])
            await session.execute(stmt)
        await session.commit()
    logger.info("Queued %d item IDs for metadata resolution", len(item_ids))


async def run_recipe_resolve():
    """Main recipe resolver entry point."""
    settings = get_settings()
    full_refresh = os.environ.get("RECIPE_FULL_REFRESH", "") == "1"
    logger.info("Starting recipe resolver (full_refresh=%s)", full_refresh)

    t0 = time.monotonic()
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    redis = None
    try:
        redis = await get_redis()
    except Exception:
        logger.warning("Redis not available, running without ETag cache")

    client = BlizzardClient(settings=settings, redis=redis)
    session_factory = get_async_session_factory()

    try:
        catalog = await discover_recipe_ids(client)

        # Incremental: skip recipes already resolved
        if not full_refresh:
            async with session_factory() as session:
                result = await session.execute(select(Recipe.id))
                known = {row[0] for row in result}
            todo = {rid: ctx for rid, ctx in catalog.items() if rid not in known}
            logger.info("%d recipes already known, %d to fetch", len(known), len(todo))
        else:
            todo = catalog

        if not todo:
            logger.info("Recipe catalog up to date, nothing to fetch")
            return

        semaphore = asyncio.Semaphore(RESOLVE_CONCURRENCY)
        item_ids_seen: set[int] = set()
        resolved = 0
        failed = 0

        async def resolve_with_semaphore(rid: int, ctx: dict):
            nonlocal resolved, failed
            async with semaphore:
                ok = await resolve_recipe(client, session_factory, rid, ctx, item_ids_seen)
                if ok:
                    resolved += 1
                else:
                    failed += 1

        items = list(todo.items())
        batch_t0 = time.monotonic()
        for batch_start in range(0, len(items), 100):
            batch = items[batch_start : batch_start + 100]
            await asyncio.gather(
                *[resolve_with_semaphore(rid, ctx) for rid, ctx in batch],
                return_exceptions=True,
            )
            done = min(batch_start + 100, len(items))
            rate = done / max(time.monotonic() - batch_t0, 0.1)
            eta_m = (len(items) - done) / max(rate, 0.01) / 60
            logger.info(
                "Progress: %d/%d (%.0f%%) | %d ok, %d failed | %.1f/s | ETA: %.1fm",
                done, len(items), 100.0 * done / len(items), resolved, failed, rate, eta_m,
            )

        await queue_item_metadata(session_factory, item_ids_seen)

        elapsed = time.monotonic() - t0
        logger.info(
            "Recipe resolver complete: %d resolved, %d failed, %.1fs elapsed. API metrics: %s",
            resolved, failed, elapsed, client.get_metrics(),
        )

    finally:
        await client.close()
        await close_redis()


if __name__ == "__main__":
    asyncio.run(run_recipe_resolve())
