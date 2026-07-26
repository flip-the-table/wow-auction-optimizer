"""
Implied constrained-material valuation — compute-pipeline orchestration.

Called from services/jobs/compute.py after the existing feature/market steps.
Gathers bounded inputs via provider classes (Phase 16 abstraction), evaluates
recipes with the pure engine in lumber_valuation.py, and upserts precomputed
rows into decor_recipe_valuations / material_value_summaries so API requests
never touch item_realm_aggregates.

Safety rails:
  * Formula-version immutability: aborts when configured params differ from
    the persisted registry entry for the same version id.
  * Fails loudly when a previously-producing setup suddenly yields zero
    eligible valuations (regression guard); silently skips when no mapping
    has ever been loaded (feature dormant).
  * Purges rows of the active formula version not refreshed by this run.
"""

import json
import logging
from datetime import datetime, timedelta

from sqlalchemy import select, text

from packages.shared.lumber_config import build_active_params, LumberFormulaParams
from packages.shared.models import (
    ConstrainedMaterial,
    DecorRecipe,
    DecorRecipeReagent,
    DecorRecipeSource,
)
from services.jobs.lumber_valuation import (
    ELIGIBLE,
    ListingInput,
    ReagentInput,
    RecipeContext,
    evaluate_recipe,
    summarize_material,
)

logger = logging.getLogger("lumber_compute")


# --- Phase 16 provider abstraction (MVP implementations = Blizzard-derived
#     aggregates already in Postgres; future adapters implement the same
#     minimal interfaces without touching the engine) -----------------------

class ListingPriceProvider:
    """Decor output listings per (item, realm) from item_realm_aggregates."""

    async def fetch(self, session, region: str, item_ids: list[int]) -> dict:
        if not item_ids:
            return {}
        rows = await session.execute(text("""
            SELECT item_id, connected_realm_id, median_buyout, min_buyout,
                   listing_count, total_quantity, updated_at,
                   demand_proxy_smoothed, snapshot_count
            FROM item_realm_aggregates
            WHERE region = :region AND item_id = ANY(:ids)
        """), {"region": region, "ids": item_ids})
        out: dict = {}
        for r in rows:
            out[(r.item_id, r.connected_realm_id)] = r
        return out


class ReagentPriceProvider:
    """Commodity (region) + realm-auction + vendor prices for reagents."""

    async def fetch_commodities(self, session, region: str, item_ids: list[int]) -> dict:
        if not item_ids:
            return {}
        rows = await session.execute(text("""
            SELECT item_id, median_unit_price, updated_at
            FROM region_commodities
            WHERE region = :region AND item_id = ANY(:ids)
        """), {"region": region, "ids": item_ids})
        return {r.item_id: r for r in rows}

    async def fetch_vendor(self, session, item_ids: list[int]) -> dict:
        if not item_ids:
            return {}
        rows = await session.execute(text("""
            SELECT id, NULLIF(purchase_price, 0) AS purchase_price
            FROM items WHERE id = ANY(:ids)
        """), {"ids": item_ids})
        return {r.id: r.purchase_price for r in rows}


class RecipeMappingProvider:
    """Active curated decor recipes + reagents + materials."""

    async def fetch(self, session):
        source = (
            await session.execute(
                select(DecorRecipeSource)
                .join(DecorRecipe, DecorRecipe.source_id == DecorRecipeSource.id)
                .where(DecorRecipe.active.is_(True))
                .limit(1)
            )
        ).scalar_one_or_none()
        recipes = (
            (await session.execute(select(DecorRecipe).where(DecorRecipe.active.is_(True))))
            .scalars().all()
        )
        reagents = (
            (await session.execute(
                select(DecorRecipeReagent).where(
                    DecorRecipeReagent.decor_recipe_id.in_([r.id for r in recipes] or [-1])
                )
            )).scalars().all()
        )
        materials = (
            (await session.execute(select(ConstrainedMaterial))).scalars().all()
        )
        return source, recipes, reagents, materials


# --- Registry immutability --------------------------------------------------

async def _ensure_formula_version(session, params: LumberFormulaParams, now) -> None:
    row = (
        await session.execute(text(
            "SELECT params FROM lumber_formula_versions WHERE formula_version = :v"
        ), {"v": params.version})
    ).first()
    current = params.to_dict()
    if row is not None:
        stored = row.params if isinstance(row.params, dict) else json.loads(row.params)
        if stored != current:
            raise RuntimeError(
                f"Formula parameters changed for existing version "
                f"{params.version!r}. Formula versions are immutable — bump "
                f"LUMBER_MODEL_FORMULA_VERSION. stored={stored} current={current}"
            )
    else:
        await session.execute(text("""
            INSERT INTO lumber_formula_versions (formula_version, params, effective_date)
            VALUES (:v, :p, :now) ON CONFLICT (formula_version) DO NOTHING
        """), {"v": params.version, "p": json.dumps(current), "now": now})


# --- Main entry -------------------------------------------------------------

async def run_lumber_valuations(session_factory, settings, now: datetime) -> None:
    params = build_active_params(settings)
    region = settings.region

    async with session_factory() as session:
        mapping = RecipeMappingProvider()
        source, recipes, reagent_rows, materials = await mapping.fetch(session)

        if not recipes:
            logger.info("Lumber valuation: no active decor recipe mapping loaded — skipping")
            return

        await _ensure_formula_version(session, params, now)

        materials_by_id = {m.id: m for m in materials}
        reagents_by_recipe: dict[int, list] = {}
        for rr in reagent_rows:
            reagents_by_recipe.setdefault(rr.decor_recipe_id, []).append(rr)

        decor_item_ids = sorted({r.decor_item_id for r in recipes})
        reagent_item_ids = sorted({
            rr.reagent_item_id for rr in reagent_rows if rr.reagent_item_id
        })

        listing_provider = ListingPriceProvider()
        price_provider = ReagentPriceProvider()
        listings = await listing_provider.fetch(session, region, decor_item_ids)
        commodities = await price_provider.fetch_commodities(session, region, reagent_item_ids)
        vendor_prices = await price_provider.fetch_vendor(session, reagent_item_ids)
        # Realm-auction reagent prices, keyed (item, realm) — reuse listing provider
        realm_reagents = await listing_provider.fetch(session, region, reagent_item_ids)

        resolved_items = {
            r[0] for r in await session.execute(text(
                "SELECT id FROM items WHERE id = ANY(:ids)"
            ), {"ids": decor_item_ids})
        }

        # Cross-realm medians per decor item (outlier anchor)
        cross_medians: dict[int, float] = {}
        by_item: dict[int, list[int]] = {}
        for (item_id, _realm), row in listings.items():
            if row.median_buyout and row.median_buyout > 0:
                by_item.setdefault(item_id, []).append(int(row.median_buyout))
        for item_id, meds in by_item.items():
            meds.sort()
            n = len(meds)
            cross_medians[item_id] = (
                meds[n // 2] if n % 2 == 1 else (meds[n // 2 - 1] + meds[n // 2]) / 2.0
            )

        realm_ids = sorted({realm for (_item, realm) in listings.keys()})

        # Regression guard: prior eligible rows for this formula version
        prev_eligible = (
            await session.execute(text("""
                SELECT COUNT(*) FROM decor_recipe_valuations
                WHERE region = :region AND formula_version = :fv
                  AND eligibility_status = 'ELIGIBLE'
            """), {"region": region, "fv": params.version})
        ).scalar() or 0

        valuation_rows: list[dict] = []
        summary_rows: list[dict] = []
        eligible_total = 0
        excluded_total = 0
        reason_counts: dict[str, int] = {}

        for material_id, material in materials_by_id.items():
            # Recipes using this material
            per_material = []
            for recipe in recipes:
                rgs = reagents_by_recipe.get(recipe.id, [])
                mine = [
                    rr for rr in rgs
                    if rr.constrained_material_id == material_id and rr.reagent_role == "CONSTRAINED"
                ]
                if not mine:
                    continue
                others_constrained = [
                    rr for rr in rgs
                    if rr.constrained_material_id
                    and rr.constrained_material_id != material_id
                ]
                per_material.append((recipe, mine[0], others_constrained, rgs))
            if not per_material:
                continue

            for realm_id in realm_ids:
                eligible_for_summary = []
                excluded_count = 0
                for recipe, mat_rr, other_constrained, rgs in per_material:
                    lrow = listings.get((recipe.decor_item_id, realm_id))
                    listing = ListingInput(
                        median=int(lrow.median_buyout) if lrow and lrow.median_buyout else None,
                        min_price=int(lrow.min_buyout) if lrow and lrow.min_buyout else None,
                        listing_count=int(lrow.listing_count) if lrow else None,
                        listed_quantity=int(lrow.total_quantity) if lrow else None,
                        updated_at=lrow.updated_at if lrow else None,
                        churn_rate=float(lrow.demand_proxy_smoothed or 0) if lrow else None,
                        snapshot_count=int(lrow.snapshot_count or 0) if lrow else 0,
                        cross_realm_median=cross_medians.get(recipe.decor_item_id),
                    )
                    reagent_inputs = []
                    for rr in rgs:
                        if rr.constrained_material_id is not None:
                            continue  # constrained handled via ctx
                        unit_price = None
                        updated = None
                        if rr.pricing_scope == "REGION_COMMODITY":
                            c = commodities.get(rr.reagent_item_id)
                            if c and c.median_unit_price:
                                unit_price = int(c.median_unit_price)
                                updated = c.updated_at
                        elif rr.pricing_scope == "REALM_AUCTION":
                            # SAME-realm price only — never cheapest-realm for a
                            # realm-scoped valuation (Phase 6.2 / 17.4)
                            a = realm_reagents.get((rr.reagent_item_id, realm_id))
                            if a and a.median_buyout:
                                unit_price = int(a.median_buyout)
                                updated = a.updated_at
                        elif rr.pricing_scope == "VENDOR":
                            vp = vendor_prices.get(rr.reagent_item_id)
                            if vp:
                                unit_price = int(vp)
                        # USER_OVERRIDE / UNPRICED → no server price in lv1
                        reagent_inputs.append(ReagentInput(
                            item_id=rr.reagent_item_id,
                            quantity=float(rr.quantity),
                            pricing_scope=rr.pricing_scope,
                            unit_price=unit_price,
                            price_updated_at=updated,
                            optional=bool(rr.optional),
                            vendor_verified=None,
                        ))

                    ctx = RecipeContext(
                        recipe_id=recipe.id,
                        crafted_quantity=float(recipe.crafted_quantity or 0),
                        material_quantity=float(mat_rr.quantity or 0),
                        verification_status=recipe.verification_status,
                        active=bool(recipe.active),
                        decor_item_resolved=recipe.decor_item_id in resolved_items,
                        other_unpriced_constrained=len(other_constrained) > 0,
                    )
                    v = evaluate_recipe(ctx, listing, reagent_inputs, params, now)

                    if v.eligibility_status == ELIGIBLE:
                        eligible_total += 1
                        eligible_for_summary.append((recipe.id, v))
                    else:
                        excluded_total += 1
                        excluded_count += 1
                        for reason in v.exclusion_reasons:
                            reason_counts[reason] = reason_counts.get(reason, 0) + 1

                    valuation_rows.append({
                        "region": region,
                        "connected_realm_id": realm_id,
                        "decor_recipe_id": recipe.id,
                        "constrained_material_id": material_id,
                        "formula_version": params.version,
                        "listing_median": listing.median,
                        "listing_min": listing.min_price,
                        "listing_count": listing.listing_count,
                        "listed_quantity": listing.listed_quantity,
                        "listing_updated_at": listing.updated_at,
                        "realized_price_factor": params.realized_price_factor,
                        "estimated_realized_unit_price": v.estimated_realized_unit_price,
                        "crafted_quantity": ctx.crafted_quantity,
                        "gross_estimated_revenue": v.gross_estimated_revenue,
                        "auction_house_cut": params.ah_cut,
                        "net_estimated_revenue": v.net_estimated_revenue,
                        "expected_deposit_loss": v.expected_deposit_loss,
                        "other_reagent_cost": v.other_reagent_cost,
                        "priced_reagent_count": v.priced_reagent_count,
                        "total_reagent_count": v.total_reagent_count,
                        "constrained_material_quantity": ctx.material_quantity,
                        "implied_value_per_material": v.implied_value_per_material,
                        "churn_rate": listing.churn_rate,
                        "estimated_market_units_per_day": round(v.estimated_market_units_per_day, 4),
                        "seller_capture_factor": params.seller_capture_factor,
                        "estimated_capturable_units_per_day": round(v.estimated_capturable_units_per_day, 4),
                        "expected_daily_contribution": v.expected_daily_contribution,
                        "freshness_score": v.freshness_score,
                        "liquidity_score": v.liquidity_score,
                        "input_quality_score": v.input_quality_score,
                        "model_confidence_score": v.model_confidence_score,
                        "eligibility_status": v.eligibility_status,
                        "exclusion_reasons": json.dumps(v.exclusion_reasons),
                        "input_snapshot_json": json.dumps({
                            "warnings": v.warnings,
                            "params": params.to_dict(),
                            "reagents": [
                                {
                                    "item_id": ri.item_id,
                                    "quantity": ri.quantity,
                                    "pricing_scope": ri.pricing_scope,
                                    "unit_price": ri.unit_price,
                                    "price_updated_at": ri.price_updated_at.isoformat() if ri.price_updated_at else None,
                                    "optional": ri.optional,
                                }
                                for ri in reagent_inputs
                            ],
                            "cross_realm_median": listing.cross_realm_median,
                            "oldest_input_at": v.oldest_input_at.isoformat() if v.oldest_input_at else None,
                        }),
                        "computed_at": now,
                    })

                summary = summarize_material(eligible_for_summary, excluded_count, params)
                summary_rows.append({
                    "region": region,
                    "connected_realm_id": realm_id,
                    "constrained_material_id": material_id,
                    "formula_version": params.version,
                    "reference_implied_value": summary.reference_implied_value,
                    "best_conversion_value": summary.best_conversion_value,
                    "conservative_implied_value": summary.conservative_implied_value,
                    "eligible_recipe_count": summary.eligible_recipe_count,
                    "excluded_recipe_count": summary.excluded_recipe_count,
                    "weighted_freshness_score": summary.weighted_freshness_score,
                    "weighted_liquidity_score": summary.weighted_liquidity_score,
                    "model_confidence_score": summary.model_confidence_score,
                    "top_recipe_id": summary.top_recipe_id,
                    "computed_at": now,
                })

        # Regression guard (Phase 19): previously healthy, suddenly nothing
        if prev_eligible > 0 and eligible_total == 0:
            raise RuntimeError(
                f"Lumber valuation regression: {prev_eligible} previously "
                f"eligible valuations, 0 now — refusing to publish empty results"
            )

        # Upserts (batched multi-row) + purge stale rows of this formula version
        await _upsert(session, "decor_recipe_valuations", valuation_rows,
                      conflict="region, connected_realm_id, decor_recipe_id, "
                               "constrained_material_id, formula_version")
        await _upsert(session, "material_value_summaries", summary_rows,
                      conflict="region, connected_realm_id, constrained_material_id, "
                               "formula_version")
        await session.execute(text("""
            DELETE FROM decor_recipe_valuations
            WHERE region = :region AND formula_version = :fv AND computed_at < :now
        """), {"region": region, "fv": params.version, "now": now})
        await session.execute(text("""
            DELETE FROM material_value_summaries
            WHERE region = :region AND formula_version = :fv AND computed_at < :now
        """), {"region": region, "fv": params.version, "now": now})

        await session.commit()

    logger.info(
        "Lumber valuation complete: source=%s formula=%s recipes=%d realms=%d "
        "eligible=%d excluded=%d reasons=%s",
        source.source_version if source else "?",
        params.version, len(recipes), len(realm_ids),
        eligible_total, excluded_total, reason_counts,
    )


async def _upsert(session, table: str, rows: list[dict], conflict: str) -> None:
    if not rows:
        return
    cols = list(rows[0].keys())
    col_list = ", ".join(cols)
    placeholders = ", ".join(f":{c}" for c in cols)
    key_cols = {c.strip() for c in conflict.split(",")}
    updates = ", ".join(
        f"{c} = EXCLUDED.{c}" for c in cols if c not in key_cols
    )
    stmt = text(
        f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}"
    )
    for start in range(0, len(rows), 500):
        await session.execute(stmt, rows[start:start + 500])
