"""
Decor Recipe Source Loader — imports a versioned curated decor→material
mapping (classification CURATED_SOURCE) into Postgres.

Guarantees:
  * Validation errors in production data exit non-zero (nothing committed).
  * A source_version is immutable: re-import with a different checksum fails.
  * Re-import with the identical checksum is an idempotent no-op re-upsert.
  * The whole import is one transaction; recipes+reagents are replaced
    atomically; the imported version becomes the single ACTIVE recipe set,
    prior versions are preserved (inactive) for auditability.
  * UNVERIFIED sources are refused without --allow-unverified (dev only).

Run: python -m services.jobs.decor_recipe_load --file data/decor_recipes/v1.0.0.json
"""

import argparse
import asyncio
import hashlib
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, delete, update, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from packages.shared.db import get_async_engine, get_async_session_factory
from packages.shared.models import (
    Base,
    ConstrainedMaterial,
    DecorRecipe,
    DecorRecipeReagent,
    DecorRecipeSource,
    ItemMetadataStatus,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("decor_recipe_load")

VALID_PRICING_SCOPES = {"REGION_COMMODITY", "REALM_AUCTION", "VENDOR", "USER_OVERRIDE", "UNPRICED"}
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[a-z0-9-]+)?$")
MATERIAL_KEY_RE = re.compile(r"^[a-z0-9_]{2,64}$")


# --- Pure validation (unit-tested without a DB) ----------------------------

def validate_source(doc: dict) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Errors reject the import."""
    errors: list[str] = []
    warnings: list[str] = []

    version = doc.get("source_version") or ""
    if not VERSION_RE.match(version):
        errors.append(f"malformed source_version: {version!r}")

    recipes = doc.get("recipes")
    if not isinstance(recipes, list) or not recipes:
        errors.append("recipes[] missing or empty")
        return errors, warnings

    seen_keys: set[str] = set()
    for i, r in enumerate(recipes):
        key = r.get("external_recipe_key") or f"<recipe {i}>"
        prefix = f"recipe {key}"

        if not r.get("external_recipe_key"):
            errors.append(f"{prefix}: external_recipe_key missing")
        elif key in seen_keys:
            errors.append(f"{prefix}: duplicate external_recipe_key in source")
        seen_keys.add(key)

        decor_item_id = r.get("decor_item_id")
        if decor_item_id is None:
            errors.append(f"{prefix}: decor_item_id missing")

        cq = r.get("crafted_quantity")
        if not isinstance(cq, (int, float)) or cq <= 0:
            errors.append(f"{prefix}: crafted_quantity must be > 0")

        lumber = r.get("lumber_reagents") or []
        if not lumber:
            errors.append(f"{prefix}: no constrained material present")
        if len(lumber) > 1:
            warnings.append(f"{prefix}: multiple constrained materials (needs overrides to value singly)")

        for lr in lumber:
            mk = lr.get("material_key") or ""
            if not MATERIAL_KEY_RE.match(mk):
                errors.append(f"{prefix}: invalid material_key {mk!r}")
            q = lr.get("quantity")
            if not isinstance(q, (int, float)) or q <= 0:
                errors.append(f"{prefix}: constrained material quantity must be > 0")
            if lr.get("item_id") is None:
                warnings.append(f"{prefix}: constrained material {mk!r} has no item_id")

        for orx in r.get("other_reagents") or []:
            q = orx.get("quantity")
            if not isinstance(q, (int, float)) or q <= 0:
                errors.append(f"{prefix}: reagent quantity must be > 0")
            scope = orx.get("pricing_scope")
            if scope not in VALID_PRICING_SCOPES:
                errors.append(f"{prefix}: invalid pricing_scope {scope!r}")
            elif scope == "UNPRICED":
                warnings.append(f"{prefix}: reagent has UNPRICED scope (will exclude valuation)")
            if orx.get("item_id") is None:
                errors.append(f"{prefix}: other reagent missing item_id")

        status = r.get("verification_status") or "UNVERIFIED"
        if status not in ("VERIFIED", "UNVERIFIED"):
            errors.append(f"{prefix}: invalid verification_status {status!r}")
        if status == "VERIFIED" and not r.get("source_reference"):
            errors.append(f"{prefix}: VERIFIED recipe requires source_reference")
        if status == "UNVERIFIED":
            warnings.append(f"{prefix}: UNVERIFIED (excluded from public aggregates)")

    return errors, warnings


def source_checksum(raw_bytes: bytes) -> str:
    return hashlib.sha256(raw_bytes).hexdigest()


# --- Import ----------------------------------------------------------------

async def load_source(path: Path, allow_unverified: bool) -> int:
    raw = path.read_bytes()
    doc = json.loads(raw)
    checksum = source_checksum(raw)

    errors, warnings = validate_source(doc)
    for w in warnings:
        logger.warning("VALIDATION WARNING: %s", w)
    if errors:
        for e in errors:
            logger.error("VALIDATION ERROR: %s", e)
        logger.error("Source rejected: %d error(s)", len(errors))
        return 2

    all_unverified = all(
        (r.get("verification_status") or "UNVERIFIED") != "VERIFIED"
        for r in doc["recipes"]
    )
    if all_unverified and not allow_unverified:
        logger.error(
            "Source contains no VERIFIED recipes; refusing production import. "
            "Use --allow-unverified for development shadow loads."
        )
        return 3

    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = get_async_session_factory()
    now = datetime.now(timezone.utc)

    async with session_factory() as session:
        # Immutability check
        existing = (
            await session.execute(
                select(DecorRecipeSource).where(
                    DecorRecipeSource.source_version == doc["source_version"]
                )
            )
        ).scalar_one_or_none()
        if existing is not None and existing.checksum != checksum:
            logger.error(
                "source_version %s already imported with a different checksum "
                "(%s != %s). Source versions are immutable — create a new version.",
                doc["source_version"], existing.checksum, checksum,
            )
            return 4

        # Upsert source metadata (parse ISO strings for date/timestamp columns)
        from datetime import date as _date
        eff = doc.get("effective_date")
        ver_at = doc.get("verified_at")
        src_row = {
            "source_version": doc["source_version"],
            "game_build": doc.get("game_build"),
            "effective_date": _date.fromisoformat(eff) if eff else None,
            "source_description": doc.get("source_description"),
            "source_method": doc.get("source_method"),
            "source_reference": doc.get("source_reference"),
            "verified_by": doc.get("verified_by"),
            "verified_at": datetime.fromisoformat(ver_at) if ver_at else None,
            "checksum": checksum,
        }
        stmt = pg_insert(DecorRecipeSource.__table__).values(**src_row)
        stmt = stmt.on_conflict_do_update(
            index_elements=["source_version"],
            set_={"checksum": checksum},  # same checksum by this point
        )
        await session.execute(stmt)
        source_id = (
            await session.execute(
                select(DecorRecipeSource.id).where(
                    DecorRecipeSource.source_version == doc["source_version"]
                )
            )
        ).scalar_one()

        # Upsert constrained materials
        material_ids: dict[str, int] = {}
        for r in doc["recipes"]:
            for lr in r.get("lumber_reagents") or []:
                mk = lr["material_key"]
                if mk in material_ids:
                    continue
                stmt = pg_insert(ConstrainedMaterial.__table__).values(
                    material_key=mk,
                    item_id=lr.get("item_id"),
                    display_name=lr.get("display_name") or mk,
                    material_type="LUMBER",
                    is_tradeable=bool(lr.get("is_tradeable", False)),
                    is_account_bound=bool(lr.get("is_account_bound", True)),
                    updated_at=now,
                ).on_conflict_do_update(
                    index_elements=["material_key"],
                    set_={
                        "item_id": lr.get("item_id"),
                        "display_name": lr.get("display_name") or mk,
                        "is_tradeable": bool(lr.get("is_tradeable", False)),
                        "is_account_bound": bool(lr.get("is_account_bound", True)),
                        "updated_at": now,
                    },
                )
                await session.execute(stmt)
                material_ids[mk] = (
                    await session.execute(
                        select(ConstrainedMaterial.id).where(
                            ConstrainedMaterial.material_key == mk
                        )
                    )
                ).scalar_one()

        # Reject recipes whose output item permanently failed metadata resolution
        decor_item_ids = {r["decor_item_id"] for r in doc["recipes"]}
        failed_items = {
            row[0]
            for row in await session.execute(
                select(ItemMetadataStatus.item_id).where(
                    ItemMetadataStatus.item_id.in_(decor_item_ids),
                    ItemMetadataStatus.status == "failed",
                    ItemMetadataStatus.attempts >= 5,
                )
            )
        }
        permanently_unresolved = [
            r["external_recipe_key"]
            for r in doc["recipes"]
            if r["decor_item_id"] in failed_items
            and (r.get("verification_status") == "VERIFIED")
        ]
        if permanently_unresolved:
            logger.error(
                "VERIFIED recipes with permanently unresolvable output items: %s",
                permanently_unresolved,
            )
            await session.rollback()
            return 5

        # Upsert recipes + replace reagents, queue metadata for outputs/reagents
        loaded = 0
        for r in doc["recipes"]:
            stmt = pg_insert(DecorRecipe.__table__).values(
                source_id=source_id,
                external_recipe_key=r["external_recipe_key"],
                decor_item_id=r["decor_item_id"],
                recipe_name=r.get("recipe_name"),
                crafted_quantity=float(r.get("crafted_quantity", 1)),
                crafting_system=r.get("crafting_system"),
                verification_status=r.get("verification_status") or "UNVERIFIED",
                active=False,  # activated below for this whole source
                updated_at=now,
            ).on_conflict_do_update(
                constraint="uq_decor_recipe_source_key",
                set_={
                    "decor_item_id": r["decor_item_id"],
                    "recipe_name": r.get("recipe_name"),
                    "crafted_quantity": float(r.get("crafted_quantity", 1)),
                    "crafting_system": r.get("crafting_system"),
                    "verification_status": r.get("verification_status") or "UNVERIFIED",
                    "updated_at": now,
                },
            )
            await session.execute(stmt)
            recipe_id = (
                await session.execute(
                    select(DecorRecipe.id).where(
                        DecorRecipe.source_id == source_id,
                        DecorRecipe.external_recipe_key == r["external_recipe_key"],
                    )
                )
            ).scalar_one()

            await session.execute(
                delete(DecorRecipeReagent.__table__).where(
                    DecorRecipeReagent.decor_recipe_id == recipe_id
                )
            )
            reagent_rows = []
            for lr in r.get("lumber_reagents") or []:
                reagent_rows.append({
                    "decor_recipe_id": recipe_id,
                    "reagent_item_id": None,
                    "constrained_material_id": material_ids[lr["material_key"]],
                    "quantity": float(lr["quantity"]),
                    "reagent_role": "CONSTRAINED",
                    "pricing_scope": "UNPRICED",
                    "optional": False,
                })
            for orx in r.get("other_reagents") or []:
                reagent_rows.append({
                    "decor_recipe_id": recipe_id,
                    "reagent_item_id": orx["item_id"],
                    "constrained_material_id": None,
                    "quantity": float(orx["quantity"]),
                    "reagent_role": "VENDOR" if orx.get("pricing_scope") == "VENDOR" else "STANDARD",
                    "pricing_scope": orx.get("pricing_scope", "REGION_COMMODITY"),
                    "optional": bool(orx.get("optional", False)),
                })
            if reagent_rows:
                await session.execute(
                    pg_insert(DecorRecipeReagent.__table__).values(reagent_rows)
                )
            loaded += 1

        # Queue metadata resolution for outputs + priced reagents
        queue_ids = {r["decor_item_id"] for r in doc["recipes"] if r["decor_item_id"]}
        for r in doc["recipes"]:
            for orx in r.get("other_reagents") or []:
                if orx.get("item_id"):
                    queue_ids.add(orx["item_id"])
        queue_ids.discard(0)
        if queue_ids:
            await session.execute(
                pg_insert(ItemMetadataStatus.__table__)
                .values([{"item_id": i, "status": "pending", "attempts": 0} for i in queue_ids])
                .on_conflict_do_nothing(index_elements=["item_id"])
            )

        # This source becomes the single active recipe set
        await session.execute(
            update(DecorRecipe.__table__)
            .values(active=(DecorRecipe.source_id == source_id))
        )

        await session.commit()

    logger.info(
        "Import complete: source %s (checksum %s…) — %d recipes loaded, %d warnings",
        doc["source_version"], checksum[:12], loaded, len(warnings),
    )
    return 0


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="Path to versioned source JSON")
    parser.add_argument(
        "--allow-unverified", action="store_true",
        help="Permit sources with zero VERIFIED recipes (development only)",
    )
    args = parser.parse_args()
    try:
        return await load_source(Path(args.file), args.allow_unverified)
    finally:
        await get_async_engine().dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
