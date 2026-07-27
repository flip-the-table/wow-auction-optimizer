-- WoW Auction Optimizer -- Initial Schema
-- This file is used as docker-entrypoint-initdb.d for the postgres container
-- and also serves as the authoritative schema definition.

CREATE TABLE IF NOT EXISTS realms (
    id              INTEGER PRIMARY KEY,
    slug            VARCHAR(128) NOT NULL,
    name            VARCHAR(256) NOT NULL,
    region          VARCHAR(16)  NOT NULL,
    connected_realm_id INTEGER NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_realms_connected ON realms(connected_realm_id);

CREATE TABLE IF NOT EXISTS items (
    id              INTEGER PRIMARY KEY,
    name            VARCHAR(512),
    quality         VARCHAR(32),
    level           INTEGER,
    item_class      VARCHAR(128),
    item_subclass   VARCHAR(128),
    required_level  INTEGER,
    max_count       INTEGER,
    is_equippable   VARCHAR(8),
    is_stackable    VARCHAR(8),
    purchase_price  BIGINT,
    sell_price      BIGINT,
    last_resolved_at TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_media (
    item_id         INTEGER PRIMARY KEY,
    icon_url        TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_metadata_status (
    item_id         INTEGER PRIMARY KEY,
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snapshots (
    id              SERIAL PRIMARY KEY,
    region          VARCHAR(16) NOT NULL,
    connected_realm_id INTEGER NOT NULL,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    etag            VARCHAR(256),
    last_modified   VARCHAR(256),
    auction_count   INTEGER,
    status          VARCHAR(32) NOT NULL DEFAULT 'success',
    error           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_snapshots_region_realm_fetched
    ON snapshots(region, connected_realm_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS item_realm_snapshot_metrics (
    id                  BIGSERIAL PRIMARY KEY,
    snapshot_id         INTEGER NOT NULL,
    item_id             INTEGER NOT NULL,
    connected_realm_id  INTEGER NOT NULL,
    listing_count       INTEGER NOT NULL DEFAULT 0,
    total_quantity      INTEGER NOT NULL DEFAULT 0,
    min_buyout          BIGINT,
    median_buyout       BIGINT,
    mean_buyout         BIGINT,
    p10_buyout          BIGINT,
    p90_buyout          BIGINT,
    vwap_buyout         BIGINT,
    demand_proxy_raw    DOUBLE PRECISION DEFAULT 0.0,
    demand_proxy_smoothed DOUBLE PRECISION DEFAULT 0.0,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_metrics_snapshot ON item_realm_snapshot_metrics(snapshot_id);
CREATE INDEX IF NOT EXISTS ix_metrics_realm_item_snapshot
    ON item_realm_snapshot_metrics(connected_realm_id, item_id, snapshot_id DESC);

CREATE TABLE IF NOT EXISTS item_realm_aggregates (
    region              VARCHAR(16) NOT NULL,
    connected_realm_id  INTEGER NOT NULL,
    item_id             INTEGER NOT NULL,
    listing_count       INTEGER DEFAULT 0,
    total_quantity      INTEGER DEFAULT 0,
    min_buyout          BIGINT,
    median_buyout       BIGINT,
    mean_buyout         BIGINT,
    vwap_buyout         BIGINT,
    ewma_price          DOUBLE PRECISION,
    ewma_demand         DOUBLE PRECISION,
    demand_proxy_raw    DOUBLE PRECISION DEFAULT 0.0,
    demand_proxy_smoothed DOUBLE PRECISION DEFAULT 0.0,
    price_mean          DOUBLE PRECISION DEFAULT 0.0,
    price_m2            DOUBLE PRECISION DEFAULT 0.0,
    demand_mean         DOUBLE PRECISION DEFAULT 0.0,
    demand_m2           DOUBLE PRECISION DEFAULT 0.0,
    snapshot_count      INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (region, connected_realm_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_aggregates_region_realm
    ON item_realm_aggregates(region, connected_realm_id);
CREATE INDEX IF NOT EXISTS ix_aggregates_region_item
    ON item_realm_aggregates(region, item_id);

CREATE TABLE IF NOT EXISTS item_realm_daily (
    region              VARCHAR(16) NOT NULL,
    connected_realm_id  INTEGER NOT NULL,
    item_id             INTEGER NOT NULL,
    date                DATE NOT NULL,
    median_price        BIGINT,
    demand_proxy        DOUBLE PRECISION DEFAULT 0.0,
    listing_count       INTEGER DEFAULT 0,
    total_quantity      INTEGER DEFAULT 0,
    PRIMARY KEY (region, connected_realm_id, item_id, date)
);
CREATE INDEX IF NOT EXISTS ix_daily_item_region
    ON item_realm_daily(region, item_id);
CREATE INDEX IF NOT EXISTS ix_daily_date
    ON item_realm_daily(date);

CREATE TABLE IF NOT EXISTS recipes (
    id              INTEGER PRIMARY KEY,
    name            VARCHAR(512),
    profession_id   INTEGER NOT NULL,
    profession_name VARCHAR(128),
    skill_tier_id   INTEGER NOT NULL,
    skill_tier_name VARCHAR(128),
    category_name   VARCHAR(256),
    crafted_item_id INTEGER,
    crafted_quantity DOUBLE PRECISION DEFAULT 1.0,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_recipes_crafted_item ON recipes(crafted_item_id);
CREATE INDEX IF NOT EXISTS ix_recipes_profession ON recipes(profession_id, skill_tier_id);

CREATE TABLE IF NOT EXISTS recipe_reagents (
    recipe_id       INTEGER NOT NULL,
    reagent_item_id INTEGER NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (recipe_id, reagent_item_id)
);
CREATE INDEX IF NOT EXISTS ix_reagents_item ON recipe_reagents(reagent_item_id);

CREATE TABLE IF NOT EXISTS region_commodities (
    region           VARCHAR(16) NOT NULL,
    item_id          INTEGER NOT NULL,
    listing_count    INTEGER DEFAULT 0,
    total_quantity   BIGINT DEFAULT 0,
    min_unit_price   BIGINT,
    median_unit_price BIGINT,
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (region, item_id)
);

CREATE TABLE IF NOT EXISTS recipe_costs (
    region           VARCHAR(16) NOT NULL,
    recipe_id        INTEGER NOT NULL,
    crafted_item_id  INTEGER NOT NULL,
    craft_cost       BIGINT,
    reagents_priced  INTEGER DEFAULT 0,
    reagents_total   INTEGER DEFAULT 0,
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (region, recipe_id)
);
CREATE INDEX IF NOT EXISTS ix_recipe_costs_item ON recipe_costs(crafted_item_id);

CREATE TABLE IF NOT EXISTS recipe_market (
    region             VARCHAR(16) NOT NULL,
    crafted_item_id    INTEGER NOT NULL,
    connected_realm_id INTEGER NOT NULL,
    sell_price         BIGINT NOT NULL,
    market_quantity    BIGINT DEFAULT 0,
    market_listings    INTEGER DEFAULT 0,
    demand_per_day     DOUBLE PRECISION DEFAULT 0,
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (region, crafted_item_id)
);


CREATE TABLE IF NOT EXISTS wow_token_prices (
    region              VARCHAR(16) PRIMARY KEY,
    price               BIGINT NOT NULL,
    blizzard_updated_at TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wow_token_history (
    region              VARCHAR(16) NOT NULL,
    blizzard_updated_at TIMESTAMPTZ NOT NULL,
    price               BIGINT NOT NULL,
    PRIMARY KEY (region, blizzard_updated_at)
);

CREATE TABLE IF NOT EXISTS live_auctions (
    region             VARCHAR(16) NOT NULL,
    connected_realm_id INTEGER NOT NULL,
    auction_id         BIGINT NOT NULL,
    item_id            INTEGER NOT NULL,
    quantity           INTEGER NOT NULL DEFAULT 1,
    time_left          VARCHAR(12) NOT NULL,
    first_seen_at      TIMESTAMPTZ NOT NULL,
    last_seen_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (region, connected_realm_id, auction_id)
);
CREATE INDEX IF NOT EXISTS ix_live_auctions_item
    ON live_auctions(region, connected_realm_id, item_id);

CREATE TABLE IF NOT EXISTS auction_flow_daily (
    region                  VARCHAR(16) NOT NULL,
    connected_realm_id      INTEGER NOT NULL,
    item_id                 INTEGER NOT NULL,
    date                    DATE NOT NULL,
    removed_early_count     INTEGER NOT NULL DEFAULT 0,
    removed_early_qty       BIGINT NOT NULL DEFAULT 0,
    removed_ambiguous_count INTEGER NOT NULL DEFAULT 0,
    removed_ambiguous_qty   BIGINT NOT NULL DEFAULT 0,
    new_count               INTEGER NOT NULL DEFAULT 0,
    new_qty                 BIGINT NOT NULL DEFAULT 0,
    snapshots               INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (region, connected_realm_id, item_id, date)
);
CREATE INDEX IF NOT EXISTS ix_flow_item ON auction_flow_daily(region, item_id, date);
CREATE INDEX IF NOT EXISTS ix_flow_date ON auction_flow_daily(date);


CREATE TABLE IF NOT EXISTS item_opportunities (
    region               VARCHAR(16) NOT NULL,
    connected_realm_id   INTEGER NOT NULL,
    item_id              INTEGER NOT NULL,
    current_price        BIGINT,
    listing_count        INTEGER,
    history_days         INTEGER NOT NULL DEFAULT 0,
    price_percentile_30d DOUBLE PRECISION,
    price_slope_7d       DOUBLE PRECISION,
    demand_slope_7d      DOUBLE PRECISION,
    supply_slope_7d      DOUBLE PRECISION,
    best_sell_day        INTEGER,
    best_day_uplift      DOUBLE PRECISION,
    opportunity_score    DOUBLE PRECISION,
    computed_at          TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (region, connected_realm_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_opportunities_score
    ON item_opportunities(region, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS ix_opportunities_realm
    ON item_opportunities(region, connected_realm_id, opportunity_score DESC);

-- ===== Implied lumber / constrained-material valuation =====

CREATE TABLE IF NOT EXISTS constrained_materials (
    id              SERIAL PRIMARY KEY,
    material_key    VARCHAR(64) NOT NULL UNIQUE,
    item_id         INTEGER REFERENCES items(id),
    display_name    VARCHAR(256) NOT NULL,
    material_type   VARCHAR(32) NOT NULL DEFAULT 'LUMBER',
    is_tradeable    BOOLEAN NOT NULL DEFAULT FALSE,
    is_account_bound BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decor_recipe_sources (
    id                 SERIAL PRIMARY KEY,
    source_version     VARCHAR(64) NOT NULL UNIQUE,
    game_build         VARCHAR(64),
    effective_date     DATE,
    source_description TEXT,
    source_method      VARCHAR(64),
    source_reference   TEXT,
    verified_by        VARCHAR(128),
    verified_at        TIMESTAMPTZ,
    checksum           VARCHAR(64) NOT NULL,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decor_recipes (
    id                  SERIAL PRIMARY KEY,
    source_id           INTEGER NOT NULL REFERENCES decor_recipe_sources(id),
    external_recipe_key VARCHAR(128) NOT NULL,
    decor_item_id       INTEGER NOT NULL,
    recipe_name         VARCHAR(256),
    crafted_quantity    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    crafting_system     VARCHAR(64),
    verification_status VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED',
    active              BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_decor_recipe_source_key UNIQUE (source_id, external_recipe_key)
);
CREATE INDEX IF NOT EXISTS ix_decor_recipes_item ON decor_recipes(decor_item_id);
CREATE INDEX IF NOT EXISTS ix_decor_recipes_source ON decor_recipes(source_id);
CREATE INDEX IF NOT EXISTS ix_decor_recipes_active_item ON decor_recipes(active, decor_item_id);

CREATE TABLE IF NOT EXISTS decor_recipe_reagents (
    id                      SERIAL PRIMARY KEY,
    decor_recipe_id         INTEGER NOT NULL REFERENCES decor_recipes(id),
    reagent_item_id         INTEGER,
    constrained_material_id INTEGER REFERENCES constrained_materials(id),
    quantity                DOUBLE PRECISION NOT NULL,
    reagent_role            VARCHAR(16) NOT NULL DEFAULT 'STANDARD',
    pricing_scope           VARCHAR(24) NOT NULL DEFAULT 'REGION_COMMODITY',
    optional                BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT ck_reagent_exactly_one_target
        CHECK ((reagent_item_id IS NULL) != (constrained_material_id IS NULL)),
    CONSTRAINT ck_reagent_positive_quantity CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS ix_decor_reagents_recipe ON decor_recipe_reagents(decor_recipe_id);

CREATE TABLE IF NOT EXISTS decor_recipe_valuations (
    region                          VARCHAR(16) NOT NULL,
    connected_realm_id              INTEGER NOT NULL,
    decor_recipe_id                 INTEGER NOT NULL,
    constrained_material_id         INTEGER NOT NULL,
    formula_version                 VARCHAR(32) NOT NULL,
    listing_median                  BIGINT,
    listing_min                     BIGINT,
    listing_count                   INTEGER,
    listed_quantity                 BIGINT,
    listing_updated_at              TIMESTAMPTZ,
    realized_price_factor           DOUBLE PRECISION,
    estimated_realized_unit_price   BIGINT,
    crafted_quantity                DOUBLE PRECISION,
    gross_estimated_revenue         BIGINT,
    auction_house_cut               DOUBLE PRECISION,
    net_estimated_revenue           BIGINT,
    expected_deposit_loss           BIGINT,
    other_reagent_cost              BIGINT,
    priced_reagent_count            INTEGER,
    total_reagent_count             INTEGER,
    constrained_material_quantity   DOUBLE PRECISION,
    implied_value_per_material      BIGINT,
    churn_rate                      DOUBLE PRECISION,
    estimated_market_units_per_day  DOUBLE PRECISION,
    seller_capture_factor           DOUBLE PRECISION,
    estimated_capturable_units_per_day DOUBLE PRECISION,
    expected_daily_contribution     BIGINT,
    freshness_score                 DOUBLE PRECISION,
    liquidity_score                 DOUBLE PRECISION,
    input_quality_score             DOUBLE PRECISION,
    model_confidence_score          DOUBLE PRECISION,
    eligibility_status              VARCHAR(16) NOT NULL,
    exclusion_reasons               JSONB,
    input_snapshot_json             JSONB,
    computed_at                     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (region, connected_realm_id, decor_recipe_id,
                 constrained_material_id, formula_version)
);
CREATE INDEX IF NOT EXISTS ix_valuations_realm_material_value
    ON decor_recipe_valuations(region, connected_realm_id, constrained_material_id,
                               implied_value_per_material DESC);
CREATE INDEX IF NOT EXISTS ix_valuations_material_contribution
    ON decor_recipe_valuations(region, constrained_material_id,
                               expected_daily_contribution DESC);
CREATE INDEX IF NOT EXISTS ix_valuations_recipe ON decor_recipe_valuations(decor_recipe_id);
CREATE INDEX IF NOT EXISTS ix_valuations_computed ON decor_recipe_valuations(computed_at);

CREATE TABLE IF NOT EXISTS material_value_summaries (
    region                    VARCHAR(16) NOT NULL,
    connected_realm_id        INTEGER NOT NULL,
    constrained_material_id   INTEGER NOT NULL,
    formula_version           VARCHAR(32) NOT NULL,
    reference_implied_value   BIGINT,
    best_conversion_value     BIGINT,
    conservative_implied_value BIGINT,
    eligible_recipe_count     INTEGER NOT NULL DEFAULT 0,
    excluded_recipe_count     INTEGER NOT NULL DEFAULT 0,
    weighted_freshness_score  DOUBLE PRECISION,
    weighted_liquidity_score  DOUBLE PRECISION,
    model_confidence_score    DOUBLE PRECISION,
    top_recipe_id             INTEGER,
    computed_at               TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (region, connected_realm_id, constrained_material_id, formula_version)
);

CREATE TABLE IF NOT EXISTS lumber_formula_versions (
    formula_version VARCHAR(32) PRIMARY KEY,
    params          JSONB NOT NULL,
    code_release    VARCHAR(64),
    effective_date  TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_realm_features_latest (
    region              VARCHAR(16) NOT NULL,
    connected_realm_id  INTEGER NOT NULL,
    item_id             INTEGER NOT NULL,
    current_price       BIGINT,
    current_demand      DOUBLE PRECISION,
    baseline_price      BIGINT,
    baseline_demand     DOUBLE PRECISION,
    price_pct_diff      DOUBLE PRECISION,
    demand_pct_diff     DOUBLE PRECISION,
    price_z             DOUBLE PRECISION,
    demand_z            DOUBLE PRECISION,
    hotness_score       DOUBLE PRECISION,
    sell_suitability_score DOUBLE PRECISION,
    confidence          DOUBLE PRECISION,
    listing_count       INTEGER,
    total_quantity      INTEGER,
    baseline_window_days INTEGER DEFAULT 14,
    snapshot_count      INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (region, connected_realm_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_features_region_hotness
    ON item_realm_features_latest(region, hotness_score DESC);
CREATE INDEX IF NOT EXISTS ix_features_region_sell
    ON item_realm_features_latest(region, sell_suitability_score DESC);
