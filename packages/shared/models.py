"""
SQLAlchemy ORM models for the WoW Auction Optimizer database.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Realm(Base):
    __tablename__ = "realms"

    id = Column(Integer, primary_key=True, autoincrement=False)
    slug = Column(String(128), nullable=False)
    name = Column(String(256), nullable=False)
    region = Column(String(16), nullable=False)
    connected_realm_id = Column(Integer, nullable=False, index=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, autoincrement=False)
    name = Column(String(512), nullable=True)
    quality = Column(String(32), nullable=True)
    level = Column(Integer, nullable=True)
    item_class = Column(String(128), nullable=True)
    item_subclass = Column(String(128), nullable=True)
    required_level = Column(Integer, nullable=True)
    max_count = Column(Integer, nullable=True)
    is_equippable = Column(String(8), nullable=True)
    is_stackable = Column(String(8), nullable=True)
    purchase_price = Column(BigInteger, nullable=True)
    sell_price = Column(BigInteger, nullable=True)
    last_resolved_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ItemMedia(Base):
    __tablename__ = "item_media"

    item_id = Column(Integer, primary_key=True, autoincrement=False)
    icon_url = Column(Text, nullable=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ItemMetadataStatus(Base):
    __tablename__ = "item_metadata_status"

    item_id = Column(Integer, primary_key=True, autoincrement=False)
    status = Column(
        String(32), nullable=False, default="pending"
    )  # pending, resolved, failed
    attempts = Column(Integer, nullable=False, default=0)
    last_attempt_at = Column(DateTime(timezone=True), nullable=True)
    last_error = Column(Text, nullable=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Snapshot(Base):
    __tablename__ = "snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    region = Column(String(16), nullable=False)
    connected_realm_id = Column(Integer, nullable=False)
    fetched_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    etag = Column(String(256), nullable=True)
    last_modified = Column(String(256), nullable=True)
    auction_count = Column(Integer, nullable=True)
    status = Column(String(32), nullable=False, default="success")
    error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index(
            "ix_snapshots_region_realm_fetched",
            "region",
            "connected_realm_id",
            fetched_at.desc(),
        ),
    )


class ItemRealmAggregate(Base):
    """Aggregated per-item per-realm stats — one row per (region, realm, item).

    Uses EWMA for running price/demand averages and Welford's online algorithm
    for incremental mean/variance (enabling z-score calculation without raw history).
    """
    __tablename__ = "item_realm_aggregates"

    # Composite PK: one row per region + realm + item
    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    item_id = Column(Integer, primary_key=True)

    # Current snapshot values
    listing_count = Column(Integer, default=0)
    total_quantity = Column(Integer, default=0)
    min_buyout = Column(BigInteger, nullable=True)
    median_buyout = Column(BigInteger, nullable=True)
    mean_buyout = Column(BigInteger, nullable=True)
    vwap_buyout = Column(BigInteger, nullable=True)

    # Listing-age mix (counts by Blizzard time_left bucket, current snapshot).
    # VERY_LONG = freshly listed … SHORT = about to expire.
    tl_short = Column(Integer, nullable=True)
    tl_medium = Column(Integer, nullable=True)
    tl_long = Column(Integer, nullable=True)
    tl_very_long = Column(Integer, nullable=True)

    # EWMA running averages
    ewma_price = Column(Float, nullable=True)
    ewma_demand = Column(Float, nullable=True)

    # Demand proxy
    demand_proxy_raw = Column(Float, default=0.0)
    demand_proxy_smoothed = Column(Float, default=0.0)

    # Welford's online algorithm for running mean + variance
    price_mean = Column(Float, default=0.0)
    price_m2 = Column(Float, default=0.0)
    demand_mean = Column(Float, default=0.0)
    demand_m2 = Column(Float, default=0.0)

    snapshot_count = Column(Integer, default=0)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index(
            "ix_aggregates_region_realm",
            "region",
            "connected_realm_id",
        ),
        # Hot path for the web API: counts/lookups by (region, item_id)
        Index(
            "ix_aggregates_region_item",
            "region",
            "item_id",
        ),
    )


class ItemRealmDaily(Base):
    """Daily summary per item per realm — one row per (region, realm, item, date).

    Lightweight time-series table for trend visualization.
    Each hourly ingest UPSERTs into this table with the latest values,
    so at the end of each day we have the most recent snapshot for that day.
    """
    __tablename__ = "item_realm_daily"

    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    item_id = Column(Integer, primary_key=True)
    date = Column(Date, primary_key=True)

    median_price = Column(BigInteger, nullable=True)
    demand_proxy = Column(Float, default=0.0)
    listing_count = Column(Integer, default=0)
    total_quantity = Column(Integer, default=0)

    __table_args__ = (
        Index(
            "ix_daily_item_region",
            "region",
            "item_id",
        ),
        # Supports pruning old history by date in cleanup.py
        Index(
            "ix_daily_date",
            "date",
        ),
    )


class Recipe(Base):
    """Profession recipe catalog (static Game Data API).

    One row per recipe; reagent requirements live in recipe_reagents.
    crafted_item_id is NULL for non-item outputs (enchants etc.) — those are
    excluded from margin computation.
    """
    __tablename__ = "recipes"

    id = Column(Integer, primary_key=True, autoincrement=False)
    name = Column(String(512), nullable=True)
    profession_id = Column(Integer, nullable=False)
    profession_name = Column(String(128), nullable=True)
    skill_tier_id = Column(Integer, nullable=False)
    skill_tier_name = Column(String(128), nullable=True)
    category_name = Column(String(256), nullable=True)
    crafted_item_id = Column(Integer, nullable=True, index=True)
    # 'api' = crafted_item came from the recipe document; 'name' = exact-name
    # backfill against AH-observed items (Blizzard omits crafted_item for
    # Dragonflight+ recipes entirely)
    crafted_item_source = Column(String(16), nullable=True)
    crafted_quantity = Column(Float, default=1.0)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_recipes_profession", "profession_id", "skill_tier_id"),
    )


class RecipeReagent(Base):
    """Reagents required by a recipe."""
    __tablename__ = "recipe_reagents"

    recipe_id = Column(Integer, primary_key=True)
    reagent_item_id = Column(Integer, primary_key=True)
    quantity = Column(Integer, nullable=False, default=1)

    __table_args__ = (
        Index("ix_reagents_item", "reagent_item_id"),
    )


class RegionCommodity(Base):
    """Region-wide commodity prices (herbs, ore, cloth... — most reagents).

    Commodities trade region-wide and are absent from per-realm auction
    responses, so they get their own aggregate table.
    """
    __tablename__ = "region_commodities"

    region = Column(String(16), primary_key=True)
    item_id = Column(Integer, primary_key=True)

    listing_count = Column(Integer, default=0)
    total_quantity = Column(BigInteger, default=0)
    min_unit_price = Column(BigInteger, nullable=True)
    median_unit_price = Column(BigInteger, nullable=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RecipeCost(Base):
    """Computed cost-to-craft per recipe per region (reagents are region-priced).

    reagents_priced < reagents_total means the cost is a partial lower bound
    (some reagent had no price source) — the UI must flag it.
    """
    __tablename__ = "recipe_costs"

    region = Column(String(16), primary_key=True)
    recipe_id = Column(Integer, primary_key=True)

    crafted_item_id = Column(Integer, nullable=False, index=True)
    craft_cost = Column(BigInteger, nullable=True)
    reagents_priced = Column(Integer, default=0)
    reagents_total = Column(Integer, default=0)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RecipeMarket(Base):
    """Precomputed best realm to sell each craftable item (highest median).

    Computed by compute.py right after recipe_costs. Serving this from a tiny
    table keeps /api/craft off the large aggregates table at request time.
    """
    __tablename__ = "recipe_market"

    region = Column(String(16), primary_key=True)
    crafted_item_id = Column(Integer, primary_key=True)

    connected_realm_id = Column(Integer, nullable=False)
    sell_price = Column(BigInteger, nullable=False)
    market_quantity = Column(BigInteger, default=0)
    market_listings = Column(Integer, default=0)
    # Estimated units sold per day on the best realm (churn x stock, capped at
    # one full stock turnover). Zero-churn lottery listings rank last.
    demand_per_day = Column(Float, default=0.0)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WowTokenPrice(Base):
    """Current WoW Token price per region (official Blizzard endpoint)."""
    __tablename__ = "wow_token_prices"

    region = Column(String(16), primary_key=True)
    price = Column(BigInteger, nullable=False)  # copper
    blizzard_updated_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WowTokenHistory(Base):
    """Token price history (one row per Blizzard-reported update)."""
    __tablename__ = "wow_token_history"

    region = Column(String(16), primary_key=True)
    blizzard_updated_at = Column(DateTime(timezone=True), primary_key=True)
    price = Column(BigInteger, nullable=False)


class LiveAuction(Base):
    """Previous-snapshot auction IDs for the relevant item universe.

    Diffed against each new snapshot to classify disappearances as
    removed-early (sold or cancelled — provably NOT expired) vs ambiguous.
    Replaced per realm on every ingest."""
    __tablename__ = "live_auctions"

    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    auction_id = Column(BigInteger, primary_key=True)
    item_id = Column(Integer, nullable=False)
    quantity = Column(Integer, nullable=False, default=1)
    time_left = Column(String(12), nullable=False)  # SHORT|MEDIUM|LONG|VERY_LONG
    first_seen_at = Column(DateTime(timezone=True), nullable=False)
    last_seen_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_live_auctions_item", "region", "connected_realm_id", "item_id"),
    )


class AuctionFlowDaily(Base):
    """Daily auction-flow accumulators per (realm, item).

    removed_early_*: auctions that disappeared although their time_left bucket
    guaranteed they could not have expired within the snapshot gap — a SALE OR
    CANCELLATION, never an expiry. removed_ambiguous_*: disappearances that
    could also be expiries. This is the observational basis for sale-rate
    estimation (never labeled 'confirmed sales' in the UI)."""
    __tablename__ = "auction_flow_daily"

    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    item_id = Column(Integer, primary_key=True)
    date = Column(Date, primary_key=True)

    removed_early_count = Column(Integer, nullable=False, default=0)
    removed_early_qty = Column(BigInteger, nullable=False, default=0)
    removed_ambiguous_count = Column(Integer, nullable=False, default=0)
    removed_ambiguous_qty = Column(BigInteger, nullable=False, default=0)
    new_count = Column(Integer, nullable=False, default=0)
    new_qty = Column(BigInteger, nullable=False, default=0)
    snapshots = Column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_flow_item", "region", "item_id", "date"),
        Index("ix_flow_date", "date"),
    )


class ItemWeekdayProfile(Base):
    """Per-item weekday price/demand rhythm, region-level, from 90d of
    item_realm_daily. rel_* are ratios to the item's own all-week average
    (1.0 = typical day). Powers the Almanac timing page: when each item
    tends to peak (sell) and trough (buy). dow 0=Sunday..6 matches
    Postgres EXTRACT(DOW) and item_opportunities.best_sell_day."""
    __tablename__ = "item_weekday_profile"

    region = Column(String(16), primary_key=True)
    item_id = Column(Integer, primary_key=True)
    dow = Column(Integer, primary_key=True)

    rel_price = Column(Float, nullable=False)
    rel_demand = Column(Float, nullable=True)
    obs_days = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), nullable=False)


class ItemOpportunity(Base):
    """Precomputed buy/sell opportunity signals per (item, realm).

    Derived from the item's OWN daily history (item_realm_daily):
      price_percentile_30d  fraction of the last 30 days with median <= current
      *_slope_7d            avg(last 3d) / avg(prior 4d) - 1
      best_sell_day         weekday (0=Sunday) with highest 90d avg price
      opportunity_score     0.4*(1-percentile) + 0.3*clamp(demand_slope)
                            + 0.3*clamp(-supply_slope)   [buy-side orientation]
    All DERIVED from listings — not sales predictions."""
    __tablename__ = "item_opportunities"

    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    item_id = Column(Integer, primary_key=True)

    current_price = Column(BigInteger, nullable=True)
    listing_count = Column(Integer, nullable=True)
    history_days = Column(Integer, nullable=False, default=0)
    price_percentile_30d = Column(Float, nullable=True)
    price_slope_7d = Column(Float, nullable=True)
    demand_slope_7d = Column(Float, nullable=True)
    supply_slope_7d = Column(Float, nullable=True)
    best_sell_day = Column(Integer, nullable=True)   # 0=Sunday .. 6=Saturday
    best_day_uplift = Column(Float, nullable=True)   # vs overall avg
    opportunity_score = Column(Float, nullable=True)
    computed_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_opportunities_score", "region", opportunity_score.desc()),
        Index("ix_opportunities_realm", "region", "connected_realm_id",
              opportunity_score.desc()),
    )


# =========================================================================
# Implied lumber / constrained-material valuation (decor conversion engine)
# =========================================================================

class ConstrainedMaterial(Base):
    """A non-tradeable (or otherwise constrained) crafting material, e.g.
    a lumber type. May or may not correspond to a Blizzard item id."""
    __tablename__ = "constrained_materials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    material_key = Column(String(64), nullable=False, unique=True)
    item_id = Column(Integer, ForeignKey("items.id"), nullable=True)
    display_name = Column(String(256), nullable=False)
    material_type = Column(String(32), nullable=False, default="LUMBER")
    is_tradeable = Column(Boolean, nullable=False, default=False)
    is_account_bound = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DecorRecipeSource(Base):
    """A versioned, curated decor-recipe mapping import. Immutable after a
    successful import (enforced by checksum in the loader)."""
    __tablename__ = "decor_recipe_sources"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_version = Column(String(64), nullable=False, unique=True)
    game_build = Column(String(64), nullable=True)
    effective_date = Column(Date, nullable=True)
    source_description = Column(Text, nullable=True)
    source_method = Column(String(64), nullable=True)
    source_reference = Column(Text, nullable=True)
    verified_by = Column(String(128), nullable=True)
    verified_at = Column(DateTime(timezone=True), nullable=True)
    checksum = Column(String(64), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class DecorRecipe(Base):
    """A curated decor recipe (NOT from the Blizzard professions catalog,
    which contains zero decor recipes as of 2026-07)."""
    __tablename__ = "decor_recipes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_id = Column(Integer, ForeignKey("decor_recipe_sources.id"), nullable=False)
    external_recipe_key = Column(String(128), nullable=False)
    decor_item_id = Column(Integer, nullable=False)
    recipe_name = Column(String(256), nullable=True)
    crafted_quantity = Column(Float, nullable=False, default=1.0)
    crafting_system = Column(String(64), nullable=True)
    verification_status = Column(String(32), nullable=False, default="UNVERIFIED")
    active = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("source_id", "external_recipe_key", name="uq_decor_recipe_source_key"),
        Index("ix_decor_recipes_item", "decor_item_id"),
        Index("ix_decor_recipes_source", "source_id"),
        Index("ix_decor_recipes_active_item", "active", "decor_item_id"),
    )


class DecorRecipeReagent(Base):
    """One reagent line of a curated decor recipe. Exactly one of
    reagent_item_id / constrained_material_id is populated."""
    __tablename__ = "decor_recipe_reagents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    decor_recipe_id = Column(Integer, ForeignKey("decor_recipes.id"), nullable=False)
    reagent_item_id = Column(Integer, nullable=True)
    constrained_material_id = Column(
        Integer, ForeignKey("constrained_materials.id"), nullable=True
    )
    quantity = Column(Float, nullable=False)
    # CONSTRAINED | STANDARD | VENDOR | OPTIONAL
    reagent_role = Column(String(16), nullable=False, default="STANDARD")
    # REGION_COMMODITY | REALM_AUCTION | VENDOR | USER_OVERRIDE | UNPRICED
    pricing_scope = Column(String(24), nullable=False, default="REGION_COMMODITY")
    optional = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "(reagent_item_id IS NULL) != (constrained_material_id IS NULL)",
            name="ck_reagent_exactly_one_target",
        ),
        CheckConstraint("quantity > 0", name="ck_reagent_positive_quantity"),
        Index("ix_decor_reagents_recipe", "decor_recipe_id"),
    )


class DecorRecipeValuation(Base):
    """Precomputed per-(region, realm, recipe, material, formula) valuation.
    Rows are written for BOTH eligible and excluded recipes so the UI can
    explain exclusions. All money columns are integer copper."""
    __tablename__ = "decor_recipe_valuations"

    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    decor_recipe_id = Column(Integer, primary_key=True)
    constrained_material_id = Column(Integer, primary_key=True)
    formula_version = Column(String(32), primary_key=True)

    # OBSERVED_LISTING inputs
    listing_median = Column(BigInteger, nullable=True)
    listing_min = Column(BigInteger, nullable=True)
    listing_count = Column(Integer, nullable=True)
    listed_quantity = Column(BigInteger, nullable=True)
    listing_updated_at = Column(DateTime(timezone=True), nullable=True)

    # MODELED revenue chain
    realized_price_factor = Column(Float, nullable=True)
    estimated_realized_unit_price = Column(BigInteger, nullable=True)
    crafted_quantity = Column(Float, nullable=True)
    gross_estimated_revenue = Column(BigInteger, nullable=True)
    auction_house_cut = Column(Float, nullable=True)
    net_estimated_revenue = Column(BigInteger, nullable=True)
    expected_deposit_loss = Column(BigInteger, nullable=True)

    # Reagent side
    other_reagent_cost = Column(BigInteger, nullable=True)
    priced_reagent_count = Column(Integer, nullable=True)
    total_reagent_count = Column(Integer, nullable=True)

    # Core output
    constrained_material_quantity = Column(Float, nullable=True)
    implied_value_per_material = Column(BigInteger, nullable=True)  # may be negative

    # DERIVED liquidity / MODELED opportunity
    churn_rate = Column(Float, nullable=True)
    estimated_market_units_per_day = Column(Float, nullable=True)
    seller_capture_factor = Column(Float, nullable=True)
    estimated_capturable_units_per_day = Column(Float, nullable=True)
    expected_daily_contribution = Column(BigInteger, nullable=True)

    # Quality components (all 0..1)
    freshness_score = Column(Float, nullable=True)
    liquidity_score = Column(Float, nullable=True)
    input_quality_score = Column(Float, nullable=True)
    model_confidence_score = Column(Float, nullable=True)

    eligibility_status = Column(String(16), nullable=False)  # ELIGIBLE | EXCLUDED
    exclusion_reasons = Column(JSONB, nullable=True)
    input_snapshot_json = Column(JSONB, nullable=True)
    computed_at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index(
            "ix_valuations_realm_material_value",
            "region", "connected_realm_id", "constrained_material_id",
            implied_value_per_material.desc(),
        ),
        Index(
            "ix_valuations_material_contribution",
            "region", "constrained_material_id",
            expected_daily_contribution.desc(),
        ),
        Index("ix_valuations_recipe", "decor_recipe_id"),
        Index("ix_valuations_computed", "computed_at"),
    )


class MaterialValueSummary(Base):
    """Precomputed per-(region, realm, material, formula) summary powering
    the primary UI card without scanning valuations."""
    __tablename__ = "material_value_summaries"

    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    constrained_material_id = Column(Integer, primary_key=True)
    formula_version = Column(String(32), primary_key=True)

    reference_implied_value = Column(BigInteger, nullable=True)  # NULL when unavailable
    best_conversion_value = Column(BigInteger, nullable=True)
    conservative_implied_value = Column(BigInteger, nullable=True)
    eligible_recipe_count = Column(Integer, nullable=False, default=0)
    excluded_recipe_count = Column(Integer, nullable=False, default=0)

    weighted_freshness_score = Column(Float, nullable=True)
    weighted_liquidity_score = Column(Float, nullable=True)
    model_confidence_score = Column(Float, nullable=True)

    top_recipe_id = Column(Integer, nullable=True)
    computed_at = Column(DateTime(timezone=True), nullable=False)


class LumberFormulaVersion(Base):
    """Persisted formula-version registry. Parameters stored here are the
    immutable meaning of a version; compute aborts if the configured params
    for an existing version differ from this record."""
    __tablename__ = "lumber_formula_versions"

    formula_version = Column(String(32), primary_key=True)
    params = Column(JSONB, nullable=False)
    code_release = Column(String(64), nullable=True)
    effective_date = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ItemRealmFeaturesLatest(Base):
    __tablename__ = "item_realm_features_latest"

    # Composite primary key: region + connected_realm_id + item_id
    region = Column(String(16), primary_key=True)
    connected_realm_id = Column(Integer, primary_key=True)
    item_id = Column(Integer, primary_key=True)

    current_price = Column(BigInteger, nullable=True)
    current_demand = Column(Float, nullable=True)

    baseline_price = Column(BigInteger, nullable=True)
    baseline_demand = Column(Float, nullable=True)

    price_pct_diff = Column(Float, nullable=True)
    demand_pct_diff = Column(Float, nullable=True)

    price_z = Column(Float, nullable=True)
    demand_z = Column(Float, nullable=True)

    hotness_score = Column(Float, nullable=True)
    sell_suitability_score = Column(Float, nullable=True)

    confidence = Column(Float, nullable=True)

    listing_count = Column(Integer, nullable=True)
    total_quantity = Column(Integer, nullable=True)

    baseline_window_days = Column(Integer, nullable=True, default=14)
    snapshot_count = Column(Integer, nullable=True, default=0)

    # Auction-flow observations (from live_auctions diffing):
    # units/day removed before they could have expired = sold or cancelled.
    removals_per_day = Column(Float, nullable=True)
    # Listing-age mix copied from the aggregate row (current snapshot)
    tl_short = Column(Integer, nullable=True)
    tl_medium = Column(Integer, nullable=True)
    tl_long = Column(Integer, nullable=True)
    tl_very_long = Column(Integer, nullable=True)

    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index(
            "ix_features_region_hotness",
            "region",
            hotness_score.desc(),
        ),
        Index(
            "ix_features_region_sell",
            "region",
            sell_suitability_score.desc(),
        ),
    )
