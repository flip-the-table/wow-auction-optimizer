"""Formula unit tests for the pure implied-material valuation engine (Phase 18.1)."""

from datetime import datetime, timedelta, timezone

from packages.shared.lumber_config import LumberFormulaParams
from services.jobs.lumber_valuation import (
    ELIGIBLE,
    EXCLUDED,
    ListingInput,
    ReagentInput,
    RecipeContext,
    R_INVALID_MATERIAL_QUANTITY,
    R_MISSING_REAGENT_PRICE,
    R_MULTIPLE_UNPRICED_CONSTRAINED,
    R_OUTLIER_LISTING_PRICE,
    R_STALE_LISTING,
    R_STALE_REAGENT_PRICE,
    R_THIN_LISTING_COUNT,
    evaluate_recipe,
)

NOW = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
FRESH = NOW - timedelta(hours=1)

PARAMS = LumberFormulaParams(
    version="test1",
    realized_price_factor=0.85,
    ah_cut=0.05,
    deposit_loss_rate=0.0,
    seller_capture_factor=0.25,
    max_input_age_hours=12,
    min_listing_count=3,
    min_listed_quantity=2,
    max_cross_realm_multiplier=5.0,
    min_eligible_recipes=3,
)


def listing(median=100_000, count=5, qty=20, updated=FRESH, churn=0.02,
            snapshots=10, cross=100_000.0):
    return ListingInput(
        median=median, min_price=median, listing_count=count,
        listed_quantity=qty, updated_at=updated, churn_rate=churn,
        snapshot_count=snapshots, cross_realm_median=cross,
    )


def ctx(crafted=1.0, material=10.0, **kw):
    return RecipeContext(
        recipe_id=1, crafted_quantity=crafted, material_quantity=material, **kw
    )


def reagent(price=1_000, qty=4.0, scope="REGION_COMMODITY", updated=FRESH, **kw):
    return ReagentInput(
        item_id=42, quantity=qty, pricing_scope=scope,
        unit_price=price, price_updated_at=updated, **kw
    )


# 1. Basic one-output, one-lumber recipe — full arithmetic pinned
def test_basic_recipe_arithmetic():
    v = evaluate_recipe(ctx(), listing(), [reagent()], PARAMS, NOW)
    assert v.eligibility_status == ELIGIBLE
    assert v.estimated_realized_unit_price == 85_000            # 100000*0.85
    assert v.gross_estimated_revenue == 85_000                  # x1 crafted
    assert v.net_estimated_revenue == 80_750                    # x0.95, deposit 0
    assert v.other_reagent_cost == 4_000                        # 4 x 1000
    assert v.net_value_available == 76_750
    assert v.implied_value_per_material == 7_675                # /10 lumber


# 2. Crafted output quantity greater than one
def test_crafted_quantity_multiplies_revenue():
    v = evaluate_recipe(ctx(crafted=3.0), listing(), [reagent()], PARAMS, NOW)
    assert v.gross_estimated_revenue == 255_000                 # 85000*3
    assert v.net_estimated_revenue == 242_250
    assert v.implied_value_per_material == round((242_250 - 4_000) / 10)


# 3. AH cut applied exactly once
def test_ah_cut_applied_once():
    v = evaluate_recipe(ctx(), listing(), [], PARAMS, NOW)
    assert v.net_estimated_revenue == round(85_000 * 0.95)


# 4/5. Reagent costs summed; constrained material NOT in other_reagent_cost
def test_constrained_material_excluded_from_cost():
    v = evaluate_recipe(ctx(), listing(), [reagent(price=500, qty=2)], PARAMS, NOW)
    assert v.other_reagent_cost == 1_000  # only the standard reagent


# 6. Negative implied value preserved (never clamped)
def test_negative_implied_value_preserved():
    v = evaluate_recipe(ctx(), listing(median=1_000), [reagent(price=10_000)], PARAMS, NOW)
    assert v.eligibility_status == ELIGIBLE
    assert v.implied_value_per_material < 0
    assert v.expected_daily_contribution == 0  # MAX(0, ...) only in opportunity


# 7. Zero lumber quantity rejected
def test_zero_material_quantity_rejected():
    v = evaluate_recipe(ctx(material=0), listing(), [reagent()], PARAMS, NOW)
    assert v.eligibility_status == EXCLUDED
    assert R_INVALID_MATERIAL_QUANTITY in v.exclusion_reasons


# 8. Missing reagent price excludes recipe (never treated as zero)
def test_missing_reagent_price_excludes():
    v = evaluate_recipe(ctx(), listing(), [reagent(price=None)], PARAMS, NOW)
    assert v.eligibility_status == EXCLUDED
    assert R_MISSING_REAGENT_PRICE in v.exclusion_reasons
    assert v.implied_value_per_material is None


# 9. Stale output listing excludes
def test_stale_listing_excludes():
    old = NOW - timedelta(hours=13)
    v = evaluate_recipe(ctx(), listing(updated=old), [reagent()], PARAMS, NOW)
    assert R_STALE_LISTING in v.exclusion_reasons


# 10. Stale reagent price excludes
def test_stale_reagent_price_excludes():
    old = NOW - timedelta(hours=13)
    v = evaluate_recipe(ctx(), listing(), [reagent(updated=old)], PARAMS, NOW)
    assert R_STALE_REAGENT_PRICE in v.exclusion_reasons


# 11. Multiple unpriced constrained materials exclude
def test_multiple_unpriced_constrained_excludes():
    v = evaluate_recipe(
        ctx(other_unpriced_constrained=True), listing(), [reagent()], PARAMS, NOW
    )
    assert R_MULTIPLE_UNPRICED_CONSTRAINED in v.exclusion_reasons


# 12. Explicit override for the second constrained material permits calculation
def test_constrained_override_permits_and_costs():
    c = ctx(other_unpriced_constrained=False)
    c = RecipeContext(**{**c.__dict__, "other_constrained_override_cost": 5_000})
    v = evaluate_recipe(c, listing(), [reagent()], PARAMS, NOW)
    assert v.eligibility_status == ELIGIBLE
    assert v.other_reagent_cost == 9_000  # 4000 + 5000 override
    assert v.implied_value_per_material == round((80_750 - 9_000) / 10)


# 13/14. Seller capture factor: no effect on base value, scales opportunity
def test_capture_factor_isolated_to_opportunity():
    p_low = PARAMS
    p_high = LumberFormulaParams(**{**PARAMS.to_dict(), "seller_capture_factor": 0.5})
    v_low = evaluate_recipe(ctx(), listing(), [reagent()], p_low, NOW)
    v_high = evaluate_recipe(ctx(), listing(), [reagent()], p_high, NOW)
    assert v_low.implied_value_per_material == v_high.implied_value_per_material
    assert v_high.expected_daily_contribution == 2 * v_low.expected_daily_contribution


# 15/16. Churn: no effect on base value, scales opportunity
def test_churn_isolated_to_opportunity():
    v_slow = evaluate_recipe(ctx(), listing(churn=0.01), [reagent()], PARAMS, NOW)
    v_fast = evaluate_recipe(ctx(), listing(churn=0.02), [reagent()], PARAMS, NOW)
    assert v_slow.implied_value_per_material == v_fast.implied_value_per_material
    assert v_fast.expected_daily_contribution > v_slow.expected_daily_contribution


# 17. Decimal output quantities
def test_decimal_crafted_quantity():
    v = evaluate_recipe(ctx(crafted=1.5), listing(), [], PARAMS, NOW)
    assert v.gross_estimated_revenue == round(85_000 * 1.5)


# 18. Copper rounding: everything integer copper
def test_copper_rounding_integers():
    v = evaluate_recipe(ctx(material=3.0), listing(median=99_999), [reagent(price=333, qty=1.5)], PARAMS, NOW)
    for field in ("estimated_realized_unit_price", "gross_estimated_revenue",
                  "net_estimated_revenue", "other_reagent_cost",
                  "implied_value_per_material"):
        assert isinstance(getattr(v, field), int)


# 19. Formula-version parameter isolation (different factor => different value)
def test_formula_param_changes_value():
    p2 = LumberFormulaParams(**{**PARAMS.to_dict(), "realized_price_factor": 0.7,
                                "version": "test2"})
    v1 = evaluate_recipe(ctx(), listing(), [reagent()], PARAMS, NOW)
    v2 = evaluate_recipe(ctx(), listing(), [reagent()], p2, NOW)
    assert v1.implied_value_per_material != v2.implied_value_per_material


# 20. Realm-scope consistency: engine evaluates exactly the inputs given —
# missing same-realm reagent price excludes rather than borrowing another realm
def test_realm_scoped_reagent_missing_excludes():
    v = evaluate_recipe(
        ctx(), listing(), [reagent(price=None, scope="REALM_AUCTION")], PARAMS, NOW
    )
    assert v.eligibility_status == EXCLUDED
    assert R_MISSING_REAGENT_PRICE in v.exclusion_reasons


# Extra guards: thin listing count, outlier price, deposit rate
def test_thin_listing_count_excludes():
    v = evaluate_recipe(ctx(), listing(count=2), [reagent()], PARAMS, NOW)
    assert R_THIN_LISTING_COUNT in v.exclusion_reasons


def test_outlier_listing_price_excludes():
    v = evaluate_recipe(ctx(), listing(median=600_000, cross=100_000.0), [reagent()], PARAMS, NOW)
    assert R_OUTLIER_LISTING_PRICE in v.exclusion_reasons


def test_deposit_rate_reduces_net():
    p = LumberFormulaParams(**{**PARAMS.to_dict(), "deposit_loss_rate": 0.02,
                               "version": "test-dep"})
    v = evaluate_recipe(ctx(), listing(), [], p, NOW)
    assert v.expected_deposit_loss == round(85_000 * 0.02)
    assert v.net_estimated_revenue == round(85_000 * 0.95) - round(85_000 * 0.02)
