"""
Pure valuation logic for the implied constrained-material ("lumber") model.

No database or network access — everything here operates on dataclasses so it
is deterministic and unit-testable. All money values are INTEGER COPPER.
Rounding happens exactly once per derived monetary quantity via _copper().

Model summary (formula version parameters in packages/shared/lumber_config.py):

  estimated_realized_unit_price = round(listing_median * realized_price_factor)
  gross_estimated_revenue      = round(realized_unit * crafted_quantity)
  expected_deposit_loss        = round(gross * deposit_loss_rate)
  net_estimated_revenue        = round(gross * (1 - ah_cut)) - deposit_loss
  other_reagent_cost           = SUM(round(qty * unit_price)) over priced,
                                 required, non-constrained reagents
  net_value_available          = net_estimated_revenue - other_reagent_cost
  implied_value_per_material   = round(net_value_available / material_qty)
                                 (negative values preserved)

  estimated_market_units_per_day     = min(churn_rate*24, 1.0) * listed_quantity
  estimated_capturable_units_per_day = market_units * seller_capture_factor
  expected_daily_contribution        = max(0, net_value_available/crafted_qty)
                                       * capturable_units   [per decor UNIT]

Deliberate properties:
  * churn / capture NEVER affect implied_value_per_material (base value and
    opportunity are separate concepts);
  * a missing or stale input EXCLUDES the recipe rather than pricing it at 0;
  * multi-constrained-material recipes are excluded unless every *other*
    constrained material has an explicit override cost.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from packages.shared.lumber_config import LumberFormulaParams

# --- Eligibility -----------------------------------------------------------

ELIGIBLE = "ELIGIBLE"
EXCLUDED = "EXCLUDED"

# Exclusion reasons (stable identifiers — surfaced in API/UI)
R_INACTIVE_RECIPE = "INACTIVE_RECIPE"
R_UNVERIFIED_RECIPE = "UNVERIFIED_RECIPE"
R_DECOR_ITEM_UNRESOLVED = "DECOR_ITEM_UNRESOLVED"
R_INVALID_MATERIAL_QUANTITY = "INVALID_MATERIAL_QUANTITY"
R_INVALID_CRAFTED_QUANTITY = "INVALID_CRAFTED_QUANTITY"
R_MISSING_LISTING = "MISSING_LISTING"
R_STALE_LISTING = "STALE_LISTING"
R_THIN_LISTING_COUNT = "THIN_LISTING_COUNT"
R_THIN_LISTED_QUANTITY = "THIN_LISTED_QUANTITY"
R_OUTLIER_LISTING_PRICE = "OUTLIER_LISTING_PRICE"
R_MISSING_REAGENT_PRICE = "MISSING_REAGENT_PRICE"
R_STALE_REAGENT_PRICE = "STALE_REAGENT_PRICE"
R_MULTIPLE_UNPRICED_CONSTRAINED = "MULTIPLE_UNPRICED_CONSTRAINED_MATERIALS"

# Warnings (recorded, do not exclude)
W_VENDOR_PRICE_UNVERIFIED = "VENDOR_PRICE_UNVERIFIED"
W_OPTIONAL_REAGENT_IGNORED = "OPTIONAL_REAGENT_IGNORED"


def _copper(x: float) -> int:
    """Single rounding point for monetary values (nearest copper)."""
    return int(round(x))


def _age_hours(ts: Optional[datetime], now: datetime) -> Optional[float]:
    if ts is None:
        return None
    return max(0.0, (now - ts).total_seconds() / 3600.0)


# --- Inputs ----------------------------------------------------------------

@dataclass(frozen=True)
class ListingInput:
    """OBSERVED_LISTING: decor output on one realm (Blizzard AH snapshot)."""
    median: Optional[int]
    min_price: Optional[int]
    listing_count: Optional[int]
    listed_quantity: Optional[int]
    updated_at: Optional[datetime]
    churn_rate: Optional[float]         # demand_proxy_smoothed (fraction/hour)
    snapshot_count: int = 0
    cross_realm_median: Optional[float] = None  # median of realm medians


@dataclass(frozen=True)
class ReagentInput:
    """One required (or optional) non-constrained reagent with its price."""
    item_id: Optional[int]
    quantity: float
    pricing_scope: str                   # REGION_COMMODITY | REALM_AUCTION | VENDOR | USER_OVERRIDE | UNPRICED
    unit_price: Optional[int]            # copper; None => unpriced
    price_updated_at: Optional[datetime] = None  # None => not staleness-checked (vendor/static)
    optional: bool = False
    vendor_verified: Optional[bool] = None       # None = unknown (no data source)


@dataclass(frozen=True)
class RecipeContext:
    recipe_id: int
    crafted_quantity: float
    material_quantity: float
    verification_status: str = "VERIFIED"
    active: bool = True
    decor_item_resolved: bool = True
    # True when the recipe contains OTHER constrained materials that have no
    # explicit override cost (renders single-material inference underdetermined)
    other_unpriced_constrained: bool = False
    # Explicit override cost (copper) for other constrained materials, summed.
    other_constrained_override_cost: int = 0


@dataclass
class RecipeValuation:
    eligibility_status: str
    exclusion_reasons: list[str]
    warnings: list[str]
    # revenue chain
    estimated_realized_unit_price: Optional[int] = None
    gross_estimated_revenue: Optional[int] = None
    expected_deposit_loss: Optional[int] = None
    net_estimated_revenue: Optional[int] = None
    other_reagent_cost: Optional[int] = None
    priced_reagent_count: int = 0
    total_reagent_count: int = 0
    net_value_available: Optional[int] = None
    implied_value_per_material: Optional[int] = None
    # liquidity / opportunity
    estimated_market_units_per_day: float = 0.0
    estimated_capturable_units_per_day: float = 0.0
    expected_daily_contribution: int = 0
    # quality components
    freshness_score: float = 0.0
    liquidity_score: float = 0.0
    input_quality_score: float = 0.0
    model_confidence_score: float = 0.0
    oldest_input_at: Optional[datetime] = None
    input_snapshot: dict = field(default_factory=dict)


# --- Core evaluation -------------------------------------------------------

def evaluate_recipe(
    ctx: RecipeContext,
    listing: ListingInput,
    reagents: list[ReagentInput],
    params: LumberFormulaParams,
    now: datetime,
) -> RecipeValuation:
    reasons: list[str] = []
    warnings: list[str] = []

    # -- structural checks --------------------------------------------------
    if not ctx.active:
        reasons.append(R_INACTIVE_RECIPE)
    if ctx.verification_status != "VERIFIED":
        reasons.append(R_UNVERIFIED_RECIPE)
    if not ctx.decor_item_resolved:
        reasons.append(R_DECOR_ITEM_UNRESOLVED)
    if ctx.material_quantity is None or ctx.material_quantity <= 0:
        reasons.append(R_INVALID_MATERIAL_QUANTITY)
    if ctx.crafted_quantity is None or ctx.crafted_quantity <= 0:
        reasons.append(R_INVALID_CRAFTED_QUANTITY)
    if ctx.other_unpriced_constrained:
        reasons.append(R_MULTIPLE_UNPRICED_CONSTRAINED)

    # -- listing checks (OBSERVED_LISTING) ----------------------------------
    listing_age = _age_hours(listing.updated_at, now)
    if listing.median is None or listing.median <= 0:
        reasons.append(R_MISSING_LISTING)
    else:
        if listing_age is None or listing_age > params.max_input_age_hours:
            reasons.append(R_STALE_LISTING)
        if (listing.listing_count or 0) < params.min_listing_count:
            reasons.append(R_THIN_LISTING_COUNT)
        if (listing.listed_quantity or 0) < params.min_listed_quantity:
            reasons.append(R_THIN_LISTED_QUANTITY)
        if (
            listing.cross_realm_median is not None
            and listing.cross_realm_median > 0
            and listing.median > listing.cross_realm_median * params.max_cross_realm_multiplier
        ):
            reasons.append(R_OUTLIER_LISTING_PRICE)

    # -- reagent pricing ----------------------------------------------------
    required = [r for r in reagents if not r.optional]
    for r in reagents:
        if r.optional:
            warnings.append(W_OPTIONAL_REAGENT_IGNORED)

    other_cost = ctx.other_constrained_override_cost
    priced = 0
    oldest_input = listing.updated_at
    vendor_uncertain = 0

    for r in required:
        if r.unit_price is None or r.unit_price < 0 or r.pricing_scope == "UNPRICED":
            reasons.append(R_MISSING_REAGENT_PRICE)
            continue
        if r.price_updated_at is not None:
            age = _age_hours(r.price_updated_at, now)
            if age is None or age > params.max_input_age_hours:
                reasons.append(R_STALE_REAGENT_PRICE)
                continue
            if oldest_input is None or r.price_updated_at < oldest_input:
                oldest_input = r.price_updated_at
        if r.pricing_scope == "VENDOR" and r.vendor_verified is not True:
            # No vendor-availability data source exists; the price is used but
            # flagged uncertain and penalized in input quality.
            vendor_uncertain += 1
            warnings.append(W_VENDOR_PRICE_UNVERIFIED)
        other_cost += _copper(r.quantity * r.unit_price)
        priced += 1

    valuation = RecipeValuation(
        eligibility_status=ELIGIBLE if not reasons else EXCLUDED,
        exclusion_reasons=sorted(set(reasons)),
        warnings=sorted(set(warnings)),
        priced_reagent_count=priced,
        total_reagent_count=len(required),
        oldest_input_at=oldest_input,
    )

    # -- numeric chain (computed when arithmetic is defined, even if the row
    #    is excluded, so diagnostics can show partial math; NEVER computed by
    #    substituting zero for a missing price) ------------------------------
    can_price = (
        listing.median is not None and listing.median > 0
        and ctx.crafted_quantity and ctx.crafted_quantity > 0
        and R_MISSING_REAGENT_PRICE not in reasons
        and R_STALE_REAGENT_PRICE not in reasons
        and R_MULTIPLE_UNPRICED_CONSTRAINED not in reasons
    )
    if can_price:
        realized = _copper(listing.median * params.realized_price_factor)
        gross = _copper(realized * ctx.crafted_quantity)
        deposit = _copper(gross * params.deposit_loss_rate)
        net = _copper(gross * (1.0 - params.ah_cut)) - deposit
        navailable = net - other_cost

        valuation.estimated_realized_unit_price = realized
        valuation.gross_estimated_revenue = gross
        valuation.expected_deposit_loss = deposit
        valuation.net_estimated_revenue = net
        valuation.other_reagent_cost = other_cost
        valuation.net_value_available = navailable
        if ctx.material_quantity and ctx.material_quantity > 0:
            # Negative implied values are preserved (unprofitable conversion).
            valuation.implied_value_per_material = _copper(
                navailable / ctx.material_quantity
            )

    # -- liquidity / opportunity (DERIVED + MODELED) ------------------------
    churn = max(0.0, listing.churn_rate or 0.0)
    listed_qty = max(0, listing.listed_quantity or 0)
    market_units = min(churn * 24.0, 1.0) * listed_qty
    capturable = market_units * params.seller_capture_factor
    valuation.estimated_market_units_per_day = market_units
    valuation.estimated_capturable_units_per_day = capturable
    if valuation.net_value_available is not None and ctx.crafted_quantity:
        per_unit_value = valuation.net_value_available / ctx.crafted_quantity
        valuation.expected_daily_contribution = _copper(
            max(0.0, per_unit_value) * capturable
        )

    # -- quality components (all bounded 0..1) ------------------------------
    valuation.freshness_score = freshness_score(
        _age_hours(valuation.oldest_input_at, now), params.max_input_age_hours
    )
    valuation.liquidity_score = liquidity_score(
        listing.listing_count or 0, listed_qty, listing.snapshot_count
    )
    valuation.input_quality_score = input_quality_score(
        vendor_uncertain_count=vendor_uncertain,
        listing_count=listing.listing_count or 0,
        verified=ctx.verification_status == "VERIFIED",
    )
    valuation.model_confidence_score = round(
        0.35 * valuation.freshness_score
        + 0.35 * valuation.liquidity_score
        + 0.30 * valuation.input_quality_score,
        4,
    )
    return valuation


# --- Quality components ----------------------------------------------------

def freshness_score(input_age_hours: Optional[float], max_age_hours: int) -> float:
    """1.0 = just refreshed, 0.0 = at/over the hard maximum (excluded anyway)."""
    if input_age_hours is None:
        return 0.0
    return round(max(0.0, 1.0 - input_age_hours / max(max_age_hours, 1)), 4)


def liquidity_score(listing_count: int, listed_quantity: int, snapshot_count: int) -> float:
    """Bounded blend: listing depth 40%, stock 30%, churn-history coverage 30%."""
    return round(
        0.4 * min(1.0, listing_count / 10.0)
        + 0.3 * min(1.0, listed_quantity / 20.0)
        + 0.3 * min(1.0, snapshot_count / 6.0),
        4,
    )


def input_quality_score(
    vendor_uncertain_count: int, listing_count: int, verified: bool
) -> float:
    """Multiplicative penalties for uncertain inputs; floor 0.1."""
    score = 1.0
    score *= 0.7 ** vendor_uncertain_count
    if listing_count < 5:
        score *= 0.9
    if not verified:
        score *= 0.85
    return round(max(0.1, score), 4)


# --- Aggregation (weighted, deterministic) ---------------------------------

def recipe_weight(v: RecipeValuation) -> float:
    """Aggregation weight = freshness x liquidity x input quality."""
    return v.freshness_score * v.liquidity_score * v.input_quality_score


def weighted_median(values: list[int], weights: list[float]) -> Optional[int]:
    """Smallest value whose cumulative weight reaches half the total.

    Deterministic: ties in value sort stably; zero total weight -> None.
    """
    return weighted_percentile(values, weights, 0.5)


def weighted_percentile(
    values: list[int], weights: list[float], p: float
) -> Optional[int]:
    if not values or len(values) != len(weights):
        return None
    pairs = sorted(zip(values, weights), key=lambda t: t[0])
    total = sum(w for _, w in pairs)
    if total <= 0:
        return None
    threshold = p * total
    cumulative = 0.0
    for value, w in pairs:
        cumulative += w
        if cumulative >= threshold - 1e-12:
            return value
    return pairs[-1][0]


@dataclass
class MaterialSummary:
    reference_implied_value: Optional[int]
    best_conversion_value: Optional[int]
    conservative_implied_value: Optional[int]
    eligible_recipe_count: int
    excluded_recipe_count: int
    weighted_freshness_score: Optional[float]
    weighted_liquidity_score: Optional[float]
    model_confidence_score: Optional[float]
    top_recipe_id: Optional[int]


def summarize_material(
    eligible: list[tuple[int, RecipeValuation]],  # (recipe_id, valuation)
    excluded_count: int,
    params: LumberFormulaParams,
) -> MaterialSummary:
    """Aggregate eligible per-recipe valuations into a material summary.

    reference/conservative values are NULL (unavailable) below the minimum
    eligible-recipe threshold; best_conversion_value is still reported (it is
    a single observable conversion, labeled with its own confidence).
    """
    eligible = [
        (rid, v) for rid, v in eligible
        if v.implied_value_per_material is not None
    ]
    if not eligible:
        return MaterialSummary(None, None, None, 0, excluded_count,
                               None, None, None, None)

    values = [v.implied_value_per_material for _, v in eligible]
    weights = [max(recipe_weight(v), 1e-9) for _, v in eligible]
    total_w = sum(weights)

    best_rid, best_v = max(eligible, key=lambda t: t[1].implied_value_per_material)

    reference = conservative = None
    if len(eligible) >= params.min_eligible_recipes:
        reference = weighted_median(values, weights)
        conservative = weighted_percentile(
            values, weights, params.conservative_percentile
        )

    def wavg(attr: str) -> float:
        return round(
            sum(getattr(v, attr) * w for (_, v), w in zip(eligible, weights)) / total_w,
            4,
        )

    return MaterialSummary(
        reference_implied_value=reference,
        best_conversion_value=best_v.implied_value_per_material,
        conservative_implied_value=conservative,
        eligible_recipe_count=len(eligible),
        excluded_recipe_count=excluded_count,
        weighted_freshness_score=wavg("freshness_score"),
        weighted_liquidity_score=wavg("liquidity_score"),
        model_confidence_score=wavg("model_confidence_score"),
        top_recipe_id=best_rid,
    )
