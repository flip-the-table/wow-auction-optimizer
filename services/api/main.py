"""
FastAPI application -- serves precomputed auction intelligence data.

All heavy computation happens in background jobs. This service only
reads from Postgres and optional Redis cache. Target: <200ms latency.
"""

import json
import logging
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from sqlalchemy import select, func, text, desc
from sqlalchemy.orm import aliased

from packages.shared.config import get_settings
from packages.shared.db import get_async_session_factory, get_async_engine
from packages.shared.models import (
    Base,
    Item,
    ItemMedia,
    ItemRealmFeaturesLatest,
    ItemRealmSnapshotMetric,
    Realm,
    Snapshot,
)
from packages.shared.schemas import (
    HealthResponse,
    HotItem,
    HotItemsResponse,
    ItemDetailResponse,
    ItemInfo,
    RealmRecommendation,
    TimeSeriesPoint,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("api")

# Optional Redis -- graceful fallback
_redis = None


async def _get_redis():
    global _redis
    if _redis is not None:
        return _redis
    try:
        from packages.shared.redis_client import get_redis
        _redis = await get_redis()
        return _redis
    except Exception:
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown hooks."""
    engine = get_async_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("API server started")
    yield
    logger.info("API server shutting down")


app = FastAPI(
    title="WoW Auction Optimizer API",
    description="Precomputed auction intelligence for World of Warcraft",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", response_model=HealthResponse)
async def health():
    """Health check -- DB connectivity + last compute timestamp."""
    settings = get_settings()
    session_factory = get_async_session_factory()
    db_ok = False
    redis_ok = False
    last_ingest = None
    last_compute = None
    realm_count = None
    item_count = None

    try:
        async with session_factory() as session:
            await session.execute(text("SELECT 1"))
            db_ok = True

            # Last ingest
            result = await session.execute(
                select(func.max(Snapshot.fetched_at))
                .where(Snapshot.status == "success")
            )
            last_ingest = result.scalar_one_or_none()

            # Last compute
            result = await session.execute(
                select(func.max(ItemRealmFeaturesLatest.updated_at))
            )
            last_compute = result.scalar_one_or_none()

            # Counts
            result = await session.execute(
                select(func.count(func.distinct(Realm.connected_realm_id)))
            )
            realm_count = result.scalar_one_or_none()

            result = await session.execute(
                select(func.count(ItemRealmFeaturesLatest.item_id.distinct()))
            )
            item_count = result.scalar_one_or_none()
    except Exception as e:
        logger.error("Health check DB error: %s", e)

    try:
        redis = await _get_redis()
        if redis:
            await redis.ping()
            redis_ok = True
    except Exception:
        pass

    return HealthResponse(
        status="ok" if db_ok else "degraded",
        db_connected=db_ok,
        redis_connected=redis_ok,
        last_ingest_at=last_ingest,
        last_compute_at=last_compute,
        realm_count=realm_count,
        item_count=item_count,
    )


@app.get("/api/hot", response_model=HotItemsResponse)
async def get_hot_items(
    mode: str = Query("both", regex="^(both|demand)$"),
    limit: int = Query(50, ge=1, le=500),
    minConfidence: float = Query(0.0, ge=0.0, le=1.0),
    realm: int | None = Query(None),
    search: str | None = Query(None),
):
    """
    Get top hot items region-wide (or for a specific realm).

    Mode:
    - "demand": sort by demand z-score only
    - "both": sort by hotness_score (weighted demand_z + price_z)

    Response includes timestamps and baseline window for all numbers shown.
    """
    settings = get_settings()

    # Try Redis cache
    cache_key = f"hot:{mode}:{limit}:{minConfidence}:{realm}:{search}"
    redis = await _get_redis()
    if redis:
        try:
            cached = await redis.get(cache_key)
            if cached:
                return HotItemsResponse(**json.loads(cached))
        except Exception:
            pass

    session_factory = get_async_session_factory()
    async with session_factory() as session:
        # Build query -- join features with items and media for display
        sort_col = (
            ItemRealmFeaturesLatest.hotness_score
            if mode == "both"
            else ItemRealmFeaturesLatest.demand_z
        )

        query = (
            select(
                ItemRealmFeaturesLatest,
                Item.name.label("item_name"),
                Item.quality.label("item_quality"),
                Item.level.label("item_level"),
                Item.item_class.label("item_class"),
                Item.item_subclass.label("item_subclass"),
                ItemMedia.icon_url.label("icon_url"),
            )
            .outerjoin(Item, ItemRealmFeaturesLatest.item_id == Item.id)
            .outerjoin(ItemMedia, ItemRealmFeaturesLatest.item_id == ItemMedia.item_id)
            .where(ItemRealmFeaturesLatest.region == settings.region)
        )

        if minConfidence > 0:
            query = query.where(ItemRealmFeaturesLatest.confidence >= minConfidence)

        if realm is not None:
            query = query.where(ItemRealmFeaturesLatest.connected_realm_id == realm)

        if search:
            query = query.where(Item.name.ilike(f"%{search}%"))

        # For region-wide view, get best realm per item.
        # We need to rank realms per item and take the best one.
        # Strategy: first get top items by best score, then for each get best realm.
        if realm is None:
            # Subquery: best hotness per item
            subq = (
                select(
                    ItemRealmFeaturesLatest.item_id,
                    func.max(sort_col).label("best_score"),
                )
                .where(ItemRealmFeaturesLatest.region == settings.region)
                .group_by(ItemRealmFeaturesLatest.item_id)
                .subquery()
            )

            query = (
                select(
                    ItemRealmFeaturesLatest,
                    Item.name.label("item_name"),
                    Item.quality.label("item_quality"),
                    Item.level.label("item_level"),
                    Item.item_class.label("item_class"),
                    Item.item_subclass.label("item_subclass"),
                    ItemMedia.icon_url.label("icon_url"),
                )
                .outerjoin(Item, ItemRealmFeaturesLatest.item_id == Item.id)
                .outerjoin(ItemMedia, ItemRealmFeaturesLatest.item_id == ItemMedia.item_id)
                .join(
                    subq,
                    (ItemRealmFeaturesLatest.item_id == subq.c.item_id)
                    & (sort_col == subq.c.best_score),
                )
                .where(ItemRealmFeaturesLatest.region == settings.region)
            )

            if minConfidence > 0:
                query = query.where(ItemRealmFeaturesLatest.confidence >= minConfidence)
            if search:
                query = query.where(Item.name.ilike(f"%{search}%"))

        query = query.order_by(desc(sort_col)).limit(limit)

        result = await session.execute(query)
        rows = result.all()

        # Build response
        items = []
        for row in rows:
            feat = row[0]  # ItemRealmFeaturesLatest
            item_name = row.item_name
            item_quality = row.item_quality
            item_level = row.item_level
            item_class = row.item_class
            item_subclass = row.item_subclass
            icon_url = row.icon_url

            # Get realm name
            realm_result = await session.execute(
                select(Realm.name)
                .where(Realm.connected_realm_id == feat.connected_realm_id)
                .limit(1)
            )
            realm_name = realm_result.scalar_one_or_none()

            # Get alternate realms (top 5 other realms for this item)
            alt_query = (
                select(ItemRealmFeaturesLatest)
                .where(ItemRealmFeaturesLatest.region == settings.region)
                .where(ItemRealmFeaturesLatest.item_id == feat.item_id)
                .where(ItemRealmFeaturesLatest.connected_realm_id != feat.connected_realm_id)
                .order_by(desc(ItemRealmFeaturesLatest.sell_suitability_score))
                .limit(5)
            )
            alt_result = await session.execute(alt_query)
            alt_rows = alt_result.scalars().all()

            alternates = []
            for alt in alt_rows:
                alt_realm_result = await session.execute(
                    select(Realm.name)
                    .where(Realm.connected_realm_id == alt.connected_realm_id)
                    .limit(1)
                )
                alt_realm_name = alt_realm_result.scalar_one_or_none()
                alternates.append(RealmRecommendation(
                    connected_realm_id=alt.connected_realm_id,
                    realm_name=alt_realm_name,
                    price_z=alt.price_z,
                    demand_z=alt.demand_z,
                    sell_suitability_score=alt.sell_suitability_score,
                    current_price=alt.current_price,
                    confidence=alt.confidence,
                ))

            items.append(HotItem(
                item=ItemInfo(
                    item_id=feat.item_id,
                    name=item_name,
                    quality=item_quality,
                    icon_url=icon_url,
                    level=item_level,
                    item_class=item_class,
                    item_subclass=item_subclass,
                ),
                best_realm=RealmRecommendation(
                    connected_realm_id=feat.connected_realm_id,
                    realm_name=realm_name,
                    price_z=feat.price_z,
                    demand_z=feat.demand_z,
                    sell_suitability_score=feat.sell_suitability_score,
                    current_price=feat.current_price,
                    confidence=feat.confidence,
                ),
                alternate_realms=alternates,
                current_price=feat.current_price,
                current_demand=feat.current_demand,
                price_pct_diff=feat.price_pct_diff,
                demand_pct_diff=feat.demand_pct_diff,
                price_z=feat.price_z,
                demand_z=feat.demand_z,
                hotness_score=feat.hotness_score,
                confidence=feat.confidence,
                baseline_window_days=feat.baseline_window_days or 14,
                updated_at=feat.updated_at,
            ))

    response = HotItemsResponse(
        items=items,
        total_count=len(items),
        mode=mode,
        region=settings.region,
        baseline_window_days=settings.baseline_window_days,
        generated_at=datetime.now(timezone.utc),
    )

    # Cache response
    if redis:
        try:
            await redis.set(cache_key, response.model_dump_json(), ex=60)
        except Exception:
            pass

    return response


@app.get("/api/item/{item_id}", response_model=ItemDetailResponse)
async def get_item_detail(
    item_id: int,
    realm: int | None = Query(None),
    days: int = Query(14, ge=1, le=90),
):
    """
    Item detail: metadata + realm leaderboard + time series.
    """
    settings = get_settings()
    session_factory = get_async_session_factory()

    async with session_factory() as session:
        # Item metadata
        item_result = await session.execute(select(Item).where(Item.id == item_id))
        item = item_result.scalar_one_or_none()

        media_result = await session.execute(
            select(ItemMedia).where(ItemMedia.item_id == item_id)
        )
        media = media_result.scalar_one_or_none()

        item_info = ItemInfo(
            item_id=item_id,
            name=item.name if item else None,
            quality=item.quality if item else None,
            icon_url=media.icon_url if media else None,
            level=item.level if item else None,
            item_class=item.item_class if item else None,
            item_subclass=item.item_subclass if item else None,
        )

        # Realm leaderboard (top realms for this item by sell suitability)
        lb_query = (
            select(ItemRealmFeaturesLatest)
            .where(ItemRealmFeaturesLatest.region == settings.region)
            .where(ItemRealmFeaturesLatest.item_id == item_id)
            .order_by(desc(ItemRealmFeaturesLatest.sell_suitability_score))
            .limit(20)
        )
        lb_result = await session.execute(lb_query)
        lb_rows = lb_result.scalars().all()

        realm_leaderboard = []
        for feat in lb_rows:
            realm_result = await session.execute(
                select(Realm.name)
                .where(Realm.connected_realm_id == feat.connected_realm_id)
                .limit(1)
            )
            realm_name = realm_result.scalar_one_or_none()
            realm_leaderboard.append(RealmRecommendation(
                connected_realm_id=feat.connected_realm_id,
                realm_name=realm_name,
                price_z=feat.price_z,
                demand_z=feat.demand_z,
                sell_suitability_score=feat.sell_suitability_score,
                current_price=feat.current_price,
                confidence=feat.confidence,
            ))

        # Time series (from snapshot metrics)
        from datetime import timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        ts_query = (
            select(
                Snapshot.fetched_at,
                ItemRealmSnapshotMetric.median_buyout,
                ItemRealmSnapshotMetric.demand_proxy_smoothed,
                ItemRealmSnapshotMetric.listing_count,
                ItemRealmSnapshotMetric.total_quantity,
            )
            .join(Snapshot, ItemRealmSnapshotMetric.snapshot_id == Snapshot.id)
            .where(ItemRealmSnapshotMetric.item_id == item_id)
            .where(Snapshot.fetched_at >= cutoff)
        )

        if realm is not None:
            ts_query = ts_query.where(
                ItemRealmSnapshotMetric.connected_realm_id == realm
            )

        ts_query = ts_query.order_by(Snapshot.fetched_at.asc())
        ts_result = await session.execute(ts_query)
        ts_rows = ts_result.all()

        time_series = [
            TimeSeriesPoint(
                timestamp=row.fetched_at,
                median_buyout=row.median_buyout,
                demand_proxy_smoothed=row.demand_proxy_smoothed,
                listing_count=row.listing_count,
                total_quantity=row.total_quantity,
            )
            for row in ts_rows
        ]

    return ItemDetailResponse(
        item=item_info,
        realm_leaderboard=realm_leaderboard,
        time_series=time_series,
        baseline_window_days=days,
        generated_at=datetime.now(timezone.utc),
    )


@app.get("/api/realms")
async def get_realms():
    """Get list of connected realms for the filter dropdown."""
    settings = get_settings()
    session_factory = get_async_session_factory()

    async with session_factory() as session:
        result = await session.execute(
            select(
                Realm.connected_realm_id,
                func.min(Realm.name).label("name"),
                func.count(Realm.id).label("realm_count"),
            )
            .where(Realm.region == settings.region)
            .group_by(Realm.connected_realm_id)
            .order_by(func.min(Realm.name))
        )
        rows = result.all()

    return [
        {
            "connected_realm_id": row.connected_realm_id,
            "name": row.name,
            "realm_count": row.realm_count,
        }
        for row in rows
    ]


if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    uvicorn.run(
        "services.api.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=True,
    )
