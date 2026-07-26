"""
SQLAlchemy ORM models for the WoW Auction Optimizer database.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Column,
    Date,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    func,
)
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
