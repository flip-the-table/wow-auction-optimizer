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
    updated_at         TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (region, crafted_item_id)
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
