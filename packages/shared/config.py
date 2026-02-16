"""
Configuration module -- loads all settings from environment variables.

Uses Pydantic Settings for validation and type coercion.
All config values come from .env or actual environment variables.
"""

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # Blizzard OAuth (optional -- only needed by ingest/meta_resolve, not compute)
    blizzard_client_id: str = Field("", description="Blizzard API client ID")
    blizzard_client_secret: str = Field("", description="Blizzard API client secret")

    # Region + locale
    region: str = Field("us", description="API region: us or eu")
    locale: str = Field("en_US", description="Locale for item names")
    namespace_dynamic: str = Field("dynamic-us", description="Dynamic namespace")
    namespace_static: str = Field("static-us", description="Static namespace")

    # Ingest cadence + scoring
    ingest_interval_minutes: int = Field(60)
    weight_demand: float = Field(0.65)
    weight_price: float = Field(0.35)

    # Liquidity guards
    min_listing_count: int = Field(20)
    min_total_quantity: int = Field(50)
    min_snapshots_for_confidence: int = Field(6)

    # EWMA smoothing
    ewma_alpha: float = Field(0.3)

    # Baseline window
    baseline_window_days: int = Field(14)

    # Database
    database_url: str = Field(
        "postgresql+asyncpg://wow:wow@localhost:5432/wow_auction"
    )
    database_url_sync: str = Field(
        "postgresql://wow:wow@localhost:5432/wow_auction"
    )

    # Redis
    redis_url: str = Field("redis://localhost:6379/0")

    # API
    api_port: int = Field(8000)
    api_host: str = Field("0.0.0.0")

    # Cloud deployment
    cloud_provider: str = Field("gcp")
    environment: str = Field("dev")
    gcp_project_id: str = Field("my-project")
    gcp_region: str = Field("us-central1")

    # Rate limiting for Blizzard API
    blizzard_rate_limit_per_second: int = Field(80)
    blizzard_max_concurrent: int = Field(10)
    meta_resolve_concurrent: int = Field(5)

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


_settings: Settings | None = None


def get_settings() -> Settings:
    """Singleton settings loader."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
