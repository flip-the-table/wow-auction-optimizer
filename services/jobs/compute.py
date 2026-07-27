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
from datetime import datetime, timezone, timedelta  # noqa: F401 (timedelta used for stale gate)
from pathlib import Path

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, text
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
    price_mean: float = 0.0,
    demand_mean: float = 0.0,
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

    # Volatility factor: coefficient of variation (std relative to mean), clamped
    # to [0, 1]. (Previously std/std, which was ~1 for any std > 1, zeroing this
    # factor for essentially every item.)
    price_cv = min(1.0, price_std / max(abs(price_mean), 1e-9)) if price_std > 0 else 0.0
    demand_cv = min(1.0, demand_std / max(abs(demand_mean), 1e-9)) if demand_std > 0 else 0.0
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


# Advisory lock key protecting the compute pipeline from overlapping runs
# (scheduled + manually dispatched). Arbitrary but stable 32-bit-safe constant.
COMPUTE_ADVISORY_LOCK_KEY = 810_640_001


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

    # Concurrent-run protection: purges use `updated_at < run_ts`, which is
    # only safe when runs are serialized. Fail fast instead of interleaving.
    lock_conn = await engine.connect()
    acquired = (
        await lock_conn.execute(
            text("SELECT pg_try_advisory_lock(:k)"), {"k": COMPUTE_ADVISORY_LOCK_KEY}
        )
    ).scalar()
    if not acquired:
        await lock_conn.close()
        raise RuntimeError(
            "Another compute run holds the advisory lock — refusing to run "
            "concurrently. Retry after the other run finishes."
        )
    try:
        await _run_compute_locked(settings, t0)
    finally:
        try:
            await lock_conn.execute(
                text("SELECT pg_advisory_unlock(:k)"), {"k": COMPUTE_ADVISORY_LOCK_KEY}
            )
        finally:
            await lock_conn.close()


async def _run_compute_locked(settings, t0):

    session_factory = get_async_session_factory()
    now = datetime.now(timezone.utc)

    async with session_factory() as session:
        # A pathological plan must FAIL, not hang for hours holding the
        # advisory lock (a 30d/90d history query once ran 2h49m into the
        # workflow timeout). Normal statements here take seconds.
        await session.execute(text("SET statement_timeout = '900000'"))  # 15 min
        # Load aggregates for the region, filtering illiquid rows in SQL.
        # (Filtering in Python previously loaded ~1.5M ORM rows to keep ~1k.)
        stmt = (
            select(ItemRealmAggregate)
            .where(ItemRealmAggregate.region == settings.region)
            .where(ItemRealmAggregate.listing_count >= settings.min_listing_count)
            .where(ItemRealmAggregate.total_quantity >= settings.min_total_quantity)
        )
        result = await session.execute(stmt)
        aggregates = result.scalars().all()

        if not aggregates:
            logger.warning("No aggregates found, nothing to compute")
            return

        logger.info("Processing %d aggregate rows", len(aggregates))

        # Auction-flow observations: units/day removed before they could have
        # expired (sold or cancelled), averaged over the last 3 observed days.
        flow_rows = await session.execute(text("""
            SELECT connected_realm_id, item_id,
                   SUM(removed_early_qty)::float / GREATEST(COUNT(DISTINCT date), 1) AS per_day
            FROM auction_flow_daily
            WHERE region = :region AND date > CURRENT_DATE - 3
            GROUP BY connected_realm_id, item_id
        """), {"region": settings.region})
        removals = {(r.connected_realm_id, r.item_id): float(r.per_day) for r in flow_rows}

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
                price_mean=agg.price_mean or 0.0,
                demand_mean=agg.demand_mean or 0.0,
            )

            # Sell suitability: items with high price AND high demand AND high confidence
            sell_suitability = max(0, price_z) * max(0, demand_z) * confidence

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
                "removals_per_day": round(
                    removals.get((agg.connected_realm_id, agg.item_id), 0.0), 4
                ),
                "tl_short": agg.tl_short or 0,
                "tl_medium": agg.tl_medium or 0,
                "tl_long": agg.tl_long or 0,
                "tl_very_long": agg.tl_very_long or 0,
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

        # Purge stale rows not refreshed this run. Without this, features_latest
        # accumulates zombie "hot" items forever (rows were observed lingering
        # for 5+ months), polluting the radar with long-dead spikes.
        purge_stmt = text(
            "DELETE FROM item_realm_features_latest "
            "WHERE region = :region AND updated_at < :run_ts"
        )
        purge_result = await session.execute(
            purge_stmt, {"region": settings.region, "run_ts": now}
        )

        # Recompute craft costs (cost of reagents per recipe, region-priced).
        # Price source priority per reagent:
        #   1. region commodity median (most reagents are commodities)
        #   2. vendor purchase price (vendor-sold reagents)
        #   3. cheapest realm median from AH aggregates (non-commodity AH items)
        # Partial costs are stored with reagents_priced < reagents_total so the
        # UI can flag them as lower bounds.
        craft_cost_stmt = text("""
            INSERT INTO recipe_costs (
                region, recipe_id, crafted_item_id, craft_cost,
                reagents_priced, reagents_total, updated_at
            )
            SELECT
                :region,
                r.id,
                r.crafted_item_id,
                SUM(COALESCE(uc.unit_cost, 0) * rr.quantity)::bigint,
                COUNT(uc.unit_cost),
                COUNT(*),
                :run_ts
            FROM recipes r
            JOIN recipe_reagents rr ON rr.recipe_id = r.id
            LEFT JOIN LATERAL (
                SELECT COALESCE(
                    (SELECT c.median_unit_price FROM region_commodities c
                     WHERE c.region = :region AND c.item_id = rr.reagent_item_id
                       AND c.updated_at > :stale_cutoff),
                    (SELECT NULLIF(i.purchase_price, 0) FROM items i
                     WHERE i.id = rr.reagent_item_id),
                    (SELECT MIN(a.median_buyout) FROM item_realm_aggregates a
                     WHERE a.region = :region AND a.item_id = rr.reagent_item_id
                       AND a.updated_at > :stale_cutoff)
                ) AS unit_cost
            ) uc ON true
            WHERE r.crafted_item_id IS NOT NULL
            GROUP BY r.id, r.crafted_item_id
            ON CONFLICT (region, recipe_id) DO UPDATE SET
                crafted_item_id = EXCLUDED.crafted_item_id,
                craft_cost = EXCLUDED.craft_cost,
                reagents_priced = EXCLUDED.reagents_priced,
                reagents_total = EXCLUDED.reagents_total,
                updated_at = EXCLUDED.updated_at
        """)
        # AH-derived prices older than 48h never enter craft costs (lenient
        # gate for the craft page; the lumber model applies its own stricter
        # per-formula staleness threshold).
        stale_cutoff = now - timedelta(hours=48)
        cost_result = await session.execute(
            craft_cost_stmt,
            {"region": settings.region, "run_ts": now, "stale_cutoff": stale_cutoff},
        )
        logger.info("Craft costs recomputed for %d recipes", cost_result.rowcount)

        # Precompute the best realm to sell each craftable item. The web API
        # serves this directly — running the aggregates window scan at request
        # time caused 504s on the small RDS instance.
        market_stmt = text("""
            WITH craftable AS (
                SELECT DISTINCT crafted_item_id AS item_id FROM recipes
                WHERE crafted_item_id IS NOT NULL
            ),
            cross_realm AS (
                -- Median of realm medians: the sanity anchor per item
                SELECT a.item_id,
                       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.median_buyout) AS cross_med
                FROM item_realm_aggregates a
                JOIN craftable c ON c.item_id = a.item_id
                WHERE a.region = :region AND a.median_buyout > 0
                GROUP BY a.item_id
            )
            INSERT INTO recipe_market (
                region, crafted_item_id, connected_realm_id,
                sell_price, market_quantity, market_listings, demand_per_day, updated_at
            )
            SELECT :region, item_id, connected_realm_id,
                   median_buyout, total_quantity, listing_count,
                   -- est. units sold/day: hourly churn x stock, capped at one
                   -- full stock turnover per day
                   LEAST(COALESCE(demand_proxy_smoothed, 0) * 24, 1.0) * total_quantity,
                   :run_ts
            FROM (
                SELECT
                    a.item_id, a.connected_realm_id, a.median_buyout,
                    a.total_quantity, a.listing_count, a.demand_proxy_smoothed,
                    ROW_NUMBER() OVER (
                        PARTITION BY a.item_id ORDER BY a.median_buyout DESC
                    ) as rn
                FROM item_realm_aggregates a
                JOIN craftable c ON c.item_id = a.item_id
                JOIN cross_realm x ON x.item_id = a.item_id
                WHERE a.region = :region
                  AND a.median_buyout > 0
                  -- Realistic-price guards: gold-cap troll listings on dead
                  -- markets otherwise dominate the margin ranking.
                  AND a.listing_count >= 3
                  AND a.median_buyout <= x.cross_med * 5
            ) ranked
            WHERE rn = 1
            ON CONFLICT (region, crafted_item_id) DO UPDATE SET
                connected_realm_id = EXCLUDED.connected_realm_id,
                sell_price = EXCLUDED.sell_price,
                market_quantity = EXCLUDED.market_quantity,
                market_listings = EXCLUDED.market_listings,
                demand_per_day = EXCLUDED.demand_per_day,
                updated_at = EXCLUDED.updated_at
        """)
        market_result = await session.execute(
            market_stmt, {"region": settings.region, "run_ts": now}
        )
        # Purge market rows for items no longer listed anywhere
        await session.execute(
            text("DELETE FROM recipe_market WHERE region = :region AND updated_at < :run_ts"),
            {"region": settings.region, "run_ts": now},
        )
        logger.info("Recipe market recomputed for %d crafted items", market_result.rowcount)

        # --- Opportunity signals (watchlist) --------------------------------
        # Buy/sell signals per Decor item-realm from its OWN daily history:
        # 30d price percentile, 7d slopes (avg last 3d vs prior 4d), and 90d
        # weekday seasonality. Requires >= 14 days of history and a live,
        # fresh, >= 3-listing market. All listing-derived — not predictions.
        # CORE WORK IS DONE — commit it NOW. The opportunity analytics below
        # are strictly best-effort: they must never be able to roll back
        # features/craft-costs/markets (a dropped connection during signal
        # computation previously rolled back the entire run's work).
        await session.commit()

        # Opportunity signals require scanning 90 days of item_realm_daily.
        # While that heap is physically bloated (pre-heal), any scan risks
        # killing the t4g.micro backend — skip until cleanup's VACUUM FULL
        # self-heal shrinks it; signals appear next run automatically.
        daily_heap_bytes = (
            await session.execute(text(
                "SELECT pg_relation_size('item_realm_daily')"
            ))
        ).scalar() or 0
        if daily_heap_bytes > 3 * 1024**3:
            logger.warning(
                "Opportunity signals SKIPPED: item_realm_daily heap is %.1f GB "
                "(bloated) — waiting for cleanup's VACUUM FULL self-heal",
                daily_heap_bytes / 1e9,
            )
            skip_opportunities = True
        else:
            skip_opportunities = False

        if skip_opportunities:
            elapsed = time.monotonic() - t0
            logger.info(
                "Compute complete: %d item-realm features upserted, %d stale rows purged in %.1fs",
                total_items, purge_result.rowcount, elapsed,
            )
            from services.jobs.lumber_compute import run_lumber_valuations
            await run_lumber_valuations(session_factory, settings, now)
            return

        # Best-effort analytics: any failure here logs a warning and the
        # run continues — core results are already committed above.
        try:
            # Plan-proof extraction: fetch the (small) Decor id list first, then
            # pull daily rows via tight (region, item_id) index ranges — no join
            # for the planner to fumble into a giant sort/hash on the weak
            # instance. All analytics then run on the indexed temp table.
            decor_ids = [
                r[0] for r in await session.execute(text(
                    "SELECT id FROM items WHERE item_subclass = 'Decor'"
                ))
            ]
            await session.execute(text("""
                CREATE TEMP TABLE tmp_decor_daily ON COMMIT DROP AS
                SELECT d.connected_realm_id, d.item_id, d.date,
                       d.median_price, d.demand_proxy, d.total_quantity
                FROM item_realm_daily d
                WHERE d.region = :region AND d.item_id = ANY(:ids)
                  AND d.date > CURRENT_DATE - 90 AND d.median_price > 0
            """), {"region": settings.region, "ids": decor_ids})
            await session.execute(text(
                "CREATE INDEX ON tmp_decor_daily (connected_realm_id, item_id)"
            ))

            opportunity_stmt = text("""
                WITH cur AS (
                    SELECT a.connected_realm_id, a.item_id,
                           a.median_buyout AS current_price, a.listing_count
                    FROM item_realm_aggregates a
                    JOIN items i ON i.id = a.item_id AND i.item_subclass = 'Decor'
                    WHERE a.region = :region AND a.median_buyout > 0
                      AND a.listing_count >= 3 AND a.updated_at > :stale_cutoff
                ),
                hist30 AS (
                    SELECT d.connected_realm_id, d.item_id,
                        COUNT(*) AS history_days,
                        AVG((d.median_price <= c.current_price)::int)::float AS price_percentile,
                        AVG(d.median_price) FILTER (WHERE d.date > CURRENT_DATE - 3) AS p_recent,
                        AVG(d.median_price) FILTER (WHERE d.date <= CURRENT_DATE - 3
                                                      AND d.date > CURRENT_DATE - 7) AS p_prior,
                        AVG(d.demand_proxy) FILTER (WHERE d.date > CURRENT_DATE - 3) AS d_recent,
                        AVG(d.demand_proxy) FILTER (WHERE d.date <= CURRENT_DATE - 3
                                                      AND d.date > CURRENT_DATE - 7) AS d_prior,
                        AVG(d.total_quantity) FILTER (WHERE d.date > CURRENT_DATE - 3) AS q_recent,
                        AVG(d.total_quantity) FILTER (WHERE d.date <= CURRENT_DATE - 3
                                                      AND d.date > CURRENT_DATE - 7) AS q_prior
                    FROM tmp_decor_daily d
                    JOIN cur c ON c.connected_realm_id = d.connected_realm_id
                              AND c.item_id = d.item_id
                    WHERE d.date > CURRENT_DATE - 30
                    GROUP BY d.connected_realm_id, d.item_id
                ),
                dow AS (
                    SELECT connected_realm_id, item_id, dow_num, dow_avg,
                           ROW_NUMBER() OVER (PARTITION BY connected_realm_id, item_id
                                              ORDER BY dow_avg DESC) AS rn,
                           AVG(dow_avg) OVER (PARTITION BY connected_realm_id, item_id) AS overall_avg
                    FROM (
                        SELECT d.connected_realm_id, d.item_id,
                               EXTRACT(DOW FROM d.date)::int AS dow_num,
                               AVG(d.median_price) AS dow_avg
                        FROM tmp_decor_daily d
                        GROUP BY 1, 2, 3
                    ) x
                )
                INSERT INTO item_opportunities (
                    region, connected_realm_id, item_id, current_price, listing_count,
                    history_days, price_percentile_30d, price_slope_7d,
                    demand_slope_7d, supply_slope_7d, best_sell_day, best_day_uplift,
                    opportunity_score, computed_at
                )
                SELECT
                    :region, c.connected_realm_id, c.item_id,
                    c.current_price, c.listing_count,
                    h.history_days,
                    h.price_percentile,
                    CASE WHEN h.p_prior > 0 THEN h.p_recent / h.p_prior - 1 END,
                    CASE WHEN h.d_prior > 0 THEN h.d_recent / h.d_prior - 1 END,
                    CASE WHEN h.q_prior > 0 THEN h.q_recent / h.q_prior - 1 END,
                    b.dow_num,
                    CASE WHEN b.overall_avg > 0 THEN b.dow_avg / b.overall_avg - 1 END,
                    0.4 * (1 - h.price_percentile)
                    + 0.3 * GREATEST(-1, LEAST(1, COALESCE(
                        CASE WHEN h.d_prior > 0 THEN h.d_recent / h.d_prior - 1 END, 0)))
                    + 0.3 * GREATEST(-1, LEAST(1, COALESCE(
                        -(CASE WHEN h.q_prior > 0 THEN h.q_recent / h.q_prior - 1 END), 0))),
                    :run_ts
                FROM cur c
                JOIN hist30 h ON h.connected_realm_id = c.connected_realm_id
                             AND h.item_id = c.item_id
                LEFT JOIN dow b ON b.rn = 1
                               AND b.connected_realm_id = c.connected_realm_id
                               AND b.item_id = c.item_id
                WHERE h.history_days >= 14
                ON CONFLICT (region, connected_realm_id, item_id) DO UPDATE SET
                    current_price = EXCLUDED.current_price,
                    listing_count = EXCLUDED.listing_count,
                    history_days = EXCLUDED.history_days,
                    price_percentile_30d = EXCLUDED.price_percentile_30d,
                    price_slope_7d = EXCLUDED.price_slope_7d,
                    demand_slope_7d = EXCLUDED.demand_slope_7d,
                    supply_slope_7d = EXCLUDED.supply_slope_7d,
                    best_sell_day = EXCLUDED.best_sell_day,
                    best_day_uplift = EXCLUDED.best_day_uplift,
                    opportunity_score = EXCLUDED.opportunity_score,
                    computed_at = EXCLUDED.computed_at
            """)
            opp_result = await session.execute(
                opportunity_stmt,
                {"region": settings.region, "run_ts": now, "stale_cutoff": stale_cutoff},
            )
            await session.execute(
                text("DELETE FROM item_opportunities WHERE region = :region AND computed_at < :run_ts"),
                {"region": settings.region, "run_ts": now},
            )
            logger.info("Opportunity signals computed for %d item-realm pairs", opp_result.rowcount)

            await session.commit()
        except Exception as e:
            logger.warning("Opportunity signals failed (non-fatal): %s", e)
            try:
                await session.rollback()
            except Exception:
                pass


    # Implied constrained-material ("lumber") valuations — precomputed here so
    # API requests never scan item_realm_aggregates. Skips cleanly when no
    # curated mapping is loaded; fails loudly on regression from a previously
    # producing state (see lumber_compute.run_lumber_valuations).
    from services.jobs.lumber_compute import run_lumber_valuations
    await run_lumber_valuations(session_factory, settings, now)

    elapsed = time.monotonic() - t0
    logger.info(
        "Compute complete: %d item-realm features upserted, %d stale rows purged in %.1fs",
        total_items,
        purge_result.rowcount,
        elapsed,
    )


async def _upsert_features(session, batch: list[dict]):
    """Upsert a batch of features into item_realm_features_latest (single multi-row INSERT)."""
    if not batch:
        return
    stmt = pg_insert(ItemRealmFeaturesLatest.__table__).values(batch)
    stmt = stmt.on_conflict_do_update(
        index_elements=["region", "connected_realm_id", "item_id"],
        set_={
            k: stmt.excluded[k]
            for k in batch[0]
            if k not in ("region", "connected_realm_id", "item_id")
        },
    )
    await session.execute(stmt)


if __name__ == "__main__":
    asyncio.run(run_compute())
