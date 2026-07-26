"""
Formula-version registry for the implied constrained-material ("lumber")
valuation model.

Immutability rule: once any valuation row has been stored under a formula
version, that version's parameters may never change meaning. The compute job
persists the effective parameters into `lumber_formula_versions` on first use
and ABORTS if the currently configured parameters differ from what was stored
under the same version id. To change model behavior, bump
LUMBER_MODEL_FORMULA_VERSION.

Classifications used across API/UI (Phase 2 domain model):
    OBSERVED_LISTING - straight from Blizzard AH snapshots (not confirmed sales)
    DERIVED          - transformed from observations (churn, scores, haircut output)
    MODELED          - depends on model assumptions (implied values, capture share)
    CURATED_SOURCE   - manually supplied recipe mappings
    USER_PROVIDED    - reserved for future user overrides
"""

from dataclasses import dataclass, asdict

CLASS_OBSERVED = "OBSERVED_LISTING"
CLASS_DERIVED = "DERIVED"
CLASS_MODELED = "MODELED"
CLASS_CURATED = "CURATED_SOURCE"
CLASS_USER = "USER_PROVIDED"


@dataclass(frozen=True)
class LumberFormulaParams:
    version: str
    realized_price_factor: float
    ah_cut: float
    deposit_loss_rate: float
    seller_capture_factor: float
    max_input_age_hours: int
    min_listing_count: int
    min_listed_quantity: int
    max_cross_realm_multiplier: float
    min_eligible_recipes: int
    # Aggregation method identifiers are part of the formula contract.
    reference_aggregation: str = "weighted_median"
    conservative_percentile: float = 0.25

    def to_dict(self) -> dict:
        return asdict(self)


def build_active_params(settings) -> LumberFormulaParams:
    """Materialize the active formula parameters from typed settings."""
    return LumberFormulaParams(
        version=settings.lumber_model_formula_version,
        realized_price_factor=settings.lumber_realized_price_factor,
        ah_cut=settings.lumber_ah_cut,
        deposit_loss_rate=settings.lumber_deposit_loss_rate,
        seller_capture_factor=settings.lumber_seller_capture_factor,
        max_input_age_hours=settings.lumber_max_input_age_hours,
        min_listing_count=settings.lumber_min_listing_count,
        min_listed_quantity=settings.lumber_min_listed_quantity,
        max_cross_realm_multiplier=settings.lumber_max_cross_realm_multiplier,
        min_eligible_recipes=settings.lumber_min_eligible_recipes,
    )
