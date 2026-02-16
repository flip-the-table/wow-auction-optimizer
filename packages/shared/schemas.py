"""
Pydantic response schemas for the API layer.
"""

from datetime import datetime

from pydantic import BaseModel


class ItemInfo(BaseModel):
    item_id: int
    name: str | None = None
    quality: str | None = None
    icon_url: str | None = None
    level: int | None = None
    item_class: str | None = None
    item_subclass: str | None = None


class RealmRecommendation(BaseModel):
    connected_realm_id: int
    realm_name: str | None = None
    price_z: float | None = None
    demand_z: float | None = None
    sell_suitability_score: float | None = None
    current_price: int | None = None
    confidence: float | None = None


class HotItem(BaseModel):
    item: ItemInfo
    best_realm: RealmRecommendation
    alternate_realms: list[RealmRecommendation] = []

    # Current values (from best realm)
    current_price: int | None = None
    current_demand: float | None = None

    # Deviations
    price_pct_diff: float | None = None
    demand_pct_diff: float | None = None
    price_z: float | None = None
    demand_z: float | None = None

    hotness_score: float | None = None
    confidence: float | None = None

    # Provenance
    baseline_window_days: int = 14
    updated_at: datetime | None = None


class HotItemsResponse(BaseModel):
    items: list[HotItem]
    total_count: int
    mode: str
    region: str
    baseline_window_days: int = 14
    generated_at: datetime


class TimeSeriesPoint(BaseModel):
    timestamp: datetime
    median_buyout: int | None = None
    demand_proxy_smoothed: float | None = None
    listing_count: int | None = None
    total_quantity: int | None = None


class ItemDetailResponse(BaseModel):
    item: ItemInfo
    realm_leaderboard: list[RealmRecommendation]
    time_series: list[TimeSeriesPoint]
    baseline_window_days: int = 14
    generated_at: datetime


class HealthResponse(BaseModel):
    status: str
    db_connected: bool
    redis_connected: bool
    last_ingest_at: datetime | None = None
    last_compute_at: datetime | None = None
    realm_count: int | None = None
    item_count: int | None = None
