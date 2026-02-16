"""
SQLAlchemy ORM models for the WoW Auction Optimizer database.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Column,
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


class ItemRealmSnapshotMetric(Base):
    __tablename__ = "item_realm_snapshot_metrics"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    snapshot_id = Column(Integer, nullable=False, index=True)
    item_id = Column(Integer, nullable=False)
    connected_realm_id = Column(Integer, nullable=False)
    listing_count = Column(Integer, nullable=False, default=0)
    total_quantity = Column(Integer, nullable=False, default=0)
    min_buyout = Column(BigInteger, nullable=True)
    median_buyout = Column(BigInteger, nullable=True)
    mean_buyout = Column(BigInteger, nullable=True)
    p10_buyout = Column(BigInteger, nullable=True)
    p90_buyout = Column(BigInteger, nullable=True)
    vwap_buyout = Column(BigInteger, nullable=True)
    demand_proxy_raw = Column(Float, nullable=True, default=0.0)
    demand_proxy_smoothed = Column(Float, nullable=True, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index(
            "ix_metrics_realm_item_snapshot",
            "connected_realm_id",
            "item_id",
            snapshot_id.desc(),
        ),
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
