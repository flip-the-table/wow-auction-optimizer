"""
Deterministic calculation traces for the implied-material valuation engine.

IMPORTANT: These are SYNTHETIC verification examples. No verified production
decor-recipe mapping exists in this repository yet (Blizzard's professions API
exposes no decor recipes, and fabricating production data is prohibited).
Each trace below exercises the exact production code path
(services/jobs/lumber_valuation.evaluate_recipe) with synthetic inputs and
independently recomputes every step with plain arithmetic, asserting equality.

Run: python scripts/verify_lumber_examples.py
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.shared.lumber_config import LumberFormulaParams
from services.jobs.lumber_valuation import (
    ListingInput, ReagentInput, RecipeContext, evaluate_recipe,
)

NOW = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
FRESH = NOW - timedelta(hours=2)

PARAMS = LumberFormulaParams(
    version="lv1", realized_price_factor=0.85, ah_cut=0.05,
    deposit_loss_rate=0.0, seller_capture_factor=0.25, max_input_age_hours=12,
    min_listing_count=3, min_listed_quantity=2, max_cross_realm_multiplier=5.0,
    min_eligible_recipes=3,
)

CASES = [
    dict(
        name="SYNTHETIC 1: simple shelf — 1 output, 10 lumber, 1 commodity reagent",
        ctx=RecipeContext(recipe_id=1, crafted_quantity=1.0, material_quantity=10.0),
        listing=ListingInput(median=250_000, min_price=240_000, listing_count=8,
                             listed_quantity=30, updated_at=FRESH, churn_rate=0.02,
                             snapshot_count=12, cross_realm_median=240_000.0),
        reagents=[ReagentInput(item_id=4306, quantity=6, pricing_scope="REGION_COMMODITY",
                               unit_price=2_500, price_updated_at=FRESH)],
    ),
    dict(
        name="SYNTHETIC 2: batch craft — 3 outputs per craft, 8 lumber",
        ctx=RecipeContext(recipe_id=2, crafted_quantity=3.0, material_quantity=8.0),
        listing=ListingInput(median=90_000, min_price=85_000, listing_count=15,
                             listed_quantity=60, updated_at=FRESH, churn_rate=0.05,
                             snapshot_count=20, cross_realm_median=95_000.0),
        reagents=[ReagentInput(item_id=2770, quantity=12, pricing_scope="REGION_COMMODITY",
                               unit_price=800, price_updated_at=FRESH)],
    ),
    dict(
        name="SYNTHETIC 3: vendor reagent (uncertain) + realm-auction reagent",
        ctx=RecipeContext(recipe_id=3, crafted_quantity=1.0, material_quantity=20.0),
        listing=ListingInput(median=1_200_000, min_price=1_100_000, listing_count=4,
                             listed_quantity=6, updated_at=FRESH, churn_rate=0.01,
                             snapshot_count=8, cross_realm_median=1_000_000.0),
        reagents=[
            ReagentInput(item_id=159, quantity=2, pricing_scope="VENDOR",
                         unit_price=50, price_updated_at=None),
            ReagentInput(item_id=250100, quantity=1, pricing_scope="REALM_AUCTION",
                         unit_price=180_000, price_updated_at=FRESH),
        ],
    ),
    dict(
        name="SYNTHETIC 4: unprofitable conversion (negative preserved)",
        ctx=RecipeContext(recipe_id=4, crafted_quantity=1.0, material_quantity=5.0),
        listing=ListingInput(median=20_000, min_price=18_000, listing_count=6,
                             listed_quantity=25, updated_at=FRESH, churn_rate=0.03,
                             snapshot_count=15, cross_realm_median=22_000.0),
        reagents=[ReagentInput(item_id=4306, quantity=10, pricing_scope="REGION_COMMODITY",
                               unit_price=5_000, price_updated_at=FRESH)],
    ),
    dict(
        name="SYNTHETIC 5: excluded — missing reagent price (never valued at zero)",
        ctx=RecipeContext(recipe_id=5, crafted_quantity=1.0, material_quantity=12.0),
        listing=ListingInput(median=300_000, min_price=280_000, listing_count=10,
                             listed_quantity=40, updated_at=FRESH, churn_rate=0.02,
                             snapshot_count=10, cross_realm_median=310_000.0),
        reagents=[ReagentInput(item_id=999999, quantity=3, pricing_scope="REALM_AUCTION",
                               unit_price=None, price_updated_at=None)],
    ),
]


def main() -> int:
    print(__doc__)
    failures = 0
    for case in CASES:
        ctx, listing, reagents = case["ctx"], case["listing"], case["reagents"]
        v = evaluate_recipe(ctx, listing, reagents, PARAMS, NOW)

        print("=" * 78)
        print(case["name"])
        print(f"  Status: {v.eligibility_status}  reasons={v.exclusion_reasons}  warnings={v.warnings}")
        print(f"  Listing median (OBSERVED_LISTING): {listing.median}c  "
              f"({listing.listing_count} listings, {listing.listed_quantity} listed, {timeago(listing.updated_at)})")

        if v.eligibility_status == "ELIGIBLE":
            # Independent recomputation with plain arithmetic
            exp_realized = round(listing.median * PARAMS.realized_price_factor)
            exp_gross = round(exp_realized * ctx.crafted_quantity)
            exp_deposit = round(exp_gross * PARAMS.deposit_loss_rate)
            exp_net = round(exp_gross * (1 - PARAMS.ah_cut)) - exp_deposit
            exp_other = sum(round(r.quantity * r.unit_price) for r in reagents
                            if not r.optional and r.unit_price is not None)
            exp_available = exp_net - exp_other
            exp_implied = round(exp_available / ctx.material_quantity)
            exp_market = min(listing.churn_rate * 24, 1.0) * listing.listed_quantity
            exp_capturable = exp_market * PARAMS.seller_capture_factor
            exp_contribution = round(max(0, exp_available / ctx.crafted_quantity) * exp_capturable)

            checks = [
                ("estimated_realized_unit_price (MODELED)", v.estimated_realized_unit_price, exp_realized),
                ("gross_estimated_revenue", v.gross_estimated_revenue, exp_gross),
                ("expected_deposit_loss", v.expected_deposit_loss, exp_deposit),
                ("net_estimated_revenue", v.net_estimated_revenue, exp_net),
                ("other_reagent_cost", v.other_reagent_cost, exp_other),
                ("net_value_available", v.net_value_available, exp_available),
                ("implied_value_per_material (MODELED)", v.implied_value_per_material, exp_implied),
                ("estimated_market_units_per_day (DERIVED)", round(v.estimated_market_units_per_day, 6), round(exp_market, 6)),
                ("estimated_capturable_units_per_day (MODELED)", round(v.estimated_capturable_units_per_day, 6), round(exp_capturable, 6)),
                ("expected_daily_contribution (MODELED)", v.expected_daily_contribution, exp_contribution),
            ]
            for label, actual, expected in checks:
                ok = actual == expected
                if not ok:
                    failures += 1
                print(f"  {'OK ' if ok else 'FAIL'} {label}: engine={actual}  independent={expected}")
            print(f"  Scores: freshness={v.freshness_score} liquidity={v.liquidity_score} "
                  f"input_quality={v.input_quality_score} model_quality={v.model_confidence_score}")
        else:
            no_value = v.implied_value_per_material is None
            if not no_value:
                failures += 1
            print(f"  {'OK ' if no_value else 'FAIL'} implied_value_per_material is None "
                  f"(excluded recipes are never valued): {v.implied_value_per_material}")

    print("=" * 78)
    print("ALL TRACES VERIFIED" if failures == 0 else f"{failures} TRACE CHECK(S) FAILED")
    return 0 if failures == 0 else 1


def timeago(ts):
    return f"{(NOW - ts).total_seconds() / 3600:.0f}h old" if ts else "no timestamp"


if __name__ == "__main__":
    sys.exit(main())
