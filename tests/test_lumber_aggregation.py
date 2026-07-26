"""Aggregation tests (Phase 18.2): weighted median/percentile + material summaries."""

from datetime import datetime, timezone

from packages.shared.lumber_config import LumberFormulaParams
from services.jobs.lumber_valuation import (
    MaterialSummary,
    RecipeValuation,
    summarize_material,
    weighted_median,
    weighted_percentile,
)

PARAMS = LumberFormulaParams(
    version="test1", realized_price_factor=0.85, ah_cut=0.05,
    deposit_loss_rate=0.0, seller_capture_factor=0.25, max_input_age_hours=12,
    min_listing_count=3, min_listed_quantity=2, max_cross_realm_multiplier=5.0,
    min_eligible_recipes=3,
)


def valuation(value, fresh=1.0, liq=1.0, quality=1.0):
    v = RecipeValuation(eligibility_status="ELIGIBLE", exclusion_reasons=[], warnings=[])
    v.implied_value_per_material = value
    v.freshness_score = fresh
    v.liquidity_score = liq
    v.input_quality_score = quality
    v.model_confidence_score = round(0.35 * fresh + 0.35 * liq + 0.30 * quality, 4)
    return v


def test_weighted_median_equal_weights():
    assert weighted_median([10, 20, 30], [1, 1, 1]) == 20


def test_weighted_median_weight_dominance():
    # Heavy weight on 10 pulls the median down
    assert weighted_median([10, 20, 30], [10, 1, 1]) == 10


def test_weighted_percentile_lower_quartile():
    assert weighted_percentile([10, 20, 30, 40], [1, 1, 1, 1], 0.25) == 10


def test_weighted_median_empty_and_zero_weight():
    assert weighted_median([], []) is None
    assert weighted_median([10], [0.0]) is None


def test_zero_eligible_recipes():
    s = summarize_material([], excluded_count=5, params=PARAMS)
    assert s.reference_implied_value is None
    assert s.best_conversion_value is None
    assert s.eligible_recipe_count == 0
    assert s.excluded_recipe_count == 5


def test_one_eligible_recipe_below_min_threshold():
    s = summarize_material([(1, valuation(5_000))], 0, PARAMS)
    # Below min_eligible_recipes: reference/conservative unavailable (None),
    # but the single observable best conversion is reported.
    assert s.reference_implied_value is None
    assert s.conservative_implied_value is None
    assert s.best_conversion_value == 5_000
    assert s.top_recipe_id == 1
    assert s.eligible_recipe_count == 1


def test_outlier_with_low_weight_does_not_dominate():
    vals = [
        (1, valuation(1_000)),
        (2, valuation(1_100)),
        (3, valuation(1_200)),
        (4, valuation(1_000_000, fresh=0.05, liq=0.05, quality=0.1)),  # near-zero weight
    ]
    s = summarize_material(vals, 0, PARAMS)
    assert s.reference_implied_value in (1_000, 1_100, 1_200)
    assert s.best_conversion_value == 1_000_000  # best is still reported
    assert s.top_recipe_id == 4


def test_negative_recipes_flow_through():
    vals = [(i, valuation(v)) for i, v in enumerate([-500, -100, 200])]
    s = summarize_material(vals, 0, PARAMS)
    assert s.reference_implied_value == -100
    assert s.best_conversion_value == 200
    assert s.conservative_implied_value == -500


def test_best_conversion_selection_and_deterministic_ordering():
    vals = [(1, valuation(100)), (2, valuation(300)), (3, valuation(200))]
    s1 = summarize_material(vals, 0, PARAMS)
    s2 = summarize_material(list(reversed(vals)), 0, PARAMS)
    assert s1.best_conversion_value == s2.best_conversion_value == 300
    assert s1.reference_implied_value == s2.reference_implied_value == 200
    assert s1.top_recipe_id == s2.top_recipe_id == 2


def test_weighted_scores_aggregate():
    vals = [(1, valuation(100, fresh=0.5)), (2, valuation(200, fresh=1.0)),
            (3, valuation(300, fresh=1.0))]
    s = summarize_material(vals, 0, PARAMS)
    assert s.weighted_freshness_score is not None
    assert 0.5 <= s.weighted_freshness_score <= 1.0
