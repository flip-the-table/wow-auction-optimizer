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

    # Ingest health: fail the run when fewer than this fraction of realms succeed
    ingest_min_success_rate: float = Field(0.5, ge=0.0, le=1.0)

    # --- Implied lumber / constrained-material valuation model ---
    # These are MODEL ASSUMPTIONS, not observed facts. Changing any of them
    # requires bumping lumber_model_formula_version (enforced at compute time).
    lumber_feature_enabled: bool = Field(False)
    lumber_model_formula_version: str = Field("lv1")
    # Haircut applied to the observed listing median to estimate a realized
    # unit price (listings are not confirmed sales).
    lumber_realized_price_factor: float = Field(0.85, gt=0.0, le=1.0)
    # Share of estimated daily market activity one seller is assumed to capture.
    lumber_seller_capture_factor: float = Field(0.25, gt=0.0, le=1.0)
    lumber_max_input_age_hours: int = Field(12, gt=0)
    lumber_min_listing_count: int = Field(3, ge=1)
    lumber_min_listed_quantity: int = Field(2, ge=1)
    lumber_ah_cut: float = Field(0.05, ge=0.0, lt=1.0)
    # Deposit losses are NOT modeled in lv1; the zero default is an explicit,
    # displayed assumption rather than an omission.
    lumber_deposit_loss_rate: float = Field(0.0, ge=0.0, lt=1.0)
    lumber_min_eligible_recipes: int = Field(3, ge=1)
    lumber_max_cross_realm_multiplier: float = Field(5.0, gt=1.0)

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
