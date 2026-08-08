// API client and shared types for the WoW Auction Optimizer frontend
// API routes are same-origin (Next.js API Route Handlers on AWS Amplify)

export interface ItemInfo {
    item_id: number;
    name: string | null;
    quality: string | null;
    icon_url: string | null;
    level: number | null;
    item_class: string | null;
    item_subclass: string | null;
}

export interface RealmRecommendation {
    connected_realm_id: number;
    realm_name: string | null;
    connected_realm_names: string | null;
    realm_count: number;
    price_z: number | null;
    demand_z: number | null;
    sell_suitability_score: number | null;
    current_price: number | null;
    confidence: number | null;
    total_quantity: number | null;
    has_features: boolean;
}

export interface HotItem {
    item: ItemInfo;
    best_realm: RealmRecommendation;
    alternate_realms: RealmRecommendation[];
    total_realm_count: number;
    hot_realm_count: number;
    current_price: number | null;
    current_demand: number | null;
    price_pct_diff: number | null;
    demand_pct_diff: number | null;
    price_z: number | null;
    demand_z: number | null;
    sizzle_score: number | null;
    confidence: number | null;
    listing_count: number | null;
    total_quantity: number | null;
    baseline_window_days: number;
    updated_at: string | null;
    /** Units/day removed before they could expire — sold OR cancelled, never
     *  labeled as confirmed sales. Null until flow data accumulates. */
    removals_per_day?: number | null;
    /** Listing counts by Blizzard time_left bucket (VERY_LONG = fresh). */
    listing_age?: { short: number; medium: number; long: number; very_long: number } | null;
}

export interface TokenResponse {
    status: 'ok' | 'unavailable';
    region?: string;
    price?: number;
    gold?: number;
    change_7d_pct?: number | null;
    blizzard_updated_at?: string | null;
    updated_at?: string | null;
}

export interface OpportunityRow {
    item: { item_id: number; name: string | null; quality: string | null; icon_url: string | null };
    connected_realm_id: number;
    realm_name: string | null;
    current_price: number | null;
    listing_count: number | null;
    history_days: number;
    price_percentile_30d: number | null;
    price_slope_7d: number | null;
    demand_slope_7d: number | null;
    supply_slope_7d: number | null;
    best_sell_day: number | null;    // 0=Sunday .. 6=Saturday
    best_day_uplift: number | null;
    opportunity_score: number | null;
    removals_per_day: number | null;
    listing_age: { short: number; medium: number; long: number; very_long: number } | null;
    computed_at: string | null;
}

export interface OpportunitiesResponse {
    status: 'ok' | 'no_data';
    rows: OpportunityRow[];
    total_returned: number;
    generated_at?: string;
}

export async function fetchOpportunities(params: {
    realm?: number;
    sort?: string;
    limit?: number;
}): Promise<OpportunitiesResponse> {
    const sp = new URLSearchParams();
    if (params.realm) sp.set('realm', String(params.realm));
    if (params.sort) sp.set('sort', params.sort);
    if (params.limit) sp.set('limit', String(params.limit));
    const res = await fetch(`/api/opportunities?${sp}`, { next: { revalidate: 300 } });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `API error: ${res.status}`);
    return body;
}

export async function fetchToken(): Promise<TokenResponse> {
    const res = await fetch('/api/token', { next: { revalidate: 900 } });
    if (!res.ok) return { status: 'unavailable' };
    return res.json();
}

export interface HotItemsResponse {
    items: HotItem[];
    total_count: number;
    mode: string;
    region: string;
    baseline_window_days: number;
    generated_at: string;
}

export interface TimeSeriesPoint {
    timestamp: string;
    median_buyout: number | null;
    demand_proxy_smoothed: number | null;
    listing_count: number | null;
    total_quantity: number | null;
}

export interface ItemDetailResponse {
    item: ItemInfo;
    /** When this item was last observed in any auction feed — old value =
     *  the "market" below is a frozen snapshot, not live listings. */
    last_seen?: string | null;
    realm_leaderboard: RealmRecommendation[];
    time_series: TimeSeriesPoint[];
    daily_time_series: {
        date: string;
        median_price: number;
        demand_proxy: number;
        listing_count: number;
        total_quantity: number;
    }[];
    base_stats: {
        all_realms: {
            realm_count: number;
            mean_price: number;
            median_price: number;
            total_available: number;
            min_price: number;
            max_price: number;
        } | null;
        selected_realm: {
            current_price: number;
            available: number;
            listing_count: number;
            mean_price: number;
            ewma_price: number;
        } | null;
    };
    baseline_window_days: number;
    generated_at: string;
}

export interface HealthResponse {
    status: string;
    db_connected: boolean;
    redis_connected: boolean;
    last_ingest_at: string | null;
    last_compute_at: string | null;
    realm_count: number | null;
    item_count: number | null;
}

export interface RealmEntry {
    connected_realm_id: number;
    name: string;
    realm_count: number;
    all_names: string[];
}

export async function fetchHotItems(params: {
    mode?: string;
    limit?: number;
    minConfidence?: number;
    realm?: number;
    search?: string;
}): Promise<HotItemsResponse> {
    const searchParams = new URLSearchParams();
    if (params.mode) searchParams.set('mode', params.mode);
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.minConfidence) searchParams.set('minConfidence', String(params.minConfidence));
    if (params.realm) searchParams.set('realm', String(params.realm));
    if (params.search) searchParams.set('search', params.search);

    const res = await fetch(`/api/hot?${searchParams}`, {
        next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchItemDetail(
    itemId: number,
    realm?: number,
    days?: number
): Promise<ItemDetailResponse> {
    const searchParams = new URLSearchParams();
    if (realm) searchParams.set('realm', String(realm));
    if (days) searchParams.set('days', String(days));

    const res = await fetch(`/api/item/${itemId}?${searchParams}`, {
        next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchRealms(): Promise<RealmEntry[]> {
    const res = await fetch(`/api/realms`, {
        next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export interface CraftReagent {
    item_id: number;
    name: string | null;
    quantity: number;
    unit_price: number | null;
}

export interface CraftRecipe {
    recipe_id: number;
    recipe_name: string | null;
    /** 'base': modern (Dragonflight+) recipe — Blizzard's API omits
     *  quality-reagent slots, so craft cost covers base reagents only. */
    cost_basis?: 'full' | 'base';
    profession_id: number;
    profession_name: string | null;
    skill_tier_name: string | null;
    crafted_quantity: number;
    item: {
        item_id: number;
        name: string | null;
        quality: string | null;
        icon_url: string | null;
        item_subclass: string | null;
    };
    craft_cost: number;
    reagents: CraftReagent[];
    best_realm: {
        connected_realm_id: number;
        realm_name: string | null;
        sell_price: number;
        market_quantity: number;
        market_listings: number;
    };
    margin: number;
    margin_pct: number | null;
    user_sell_price?: number | null;
    user_market_quantity?: number | null;
    user_margin?: number | null;
    est_sales_per_day?: number;
    expected_daily_gold?: number;
}

export interface CraftResponse {
    recipes: CraftRecipe[];
    /** Present when a character was requested and resolved: margins for every
     *  recipe the character knows (not just the global top-N). */
    known_recipes?: CraftRecipe[];
    known_recipe_count?: number;
    professions: { id: number; name: string }[];
    total_count: number;
    region: string;
    ah_cut: number;
    generated_at: string;
}

export async function fetchCraftable(params: {
    limit?: number;
    decorOnly?: boolean;
    profession?: number;
    search?: string;
    realm?: number;
    includeInactive?: boolean;
    includeOldXpacs?: boolean;
    charRealm?: string;
    charName?: string;
}): Promise<CraftResponse> {
    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.decorOnly) searchParams.set('decor', '1');
    if (params.profession) searchParams.set('profession', String(params.profession));
    if (params.search) searchParams.set('search', params.search);
    if (params.realm) searchParams.set('realm', String(params.realm));
    if (params.includeInactive) searchParams.set('active', '0');
    if (params.includeOldXpacs) searchParams.set('xpac', 'all');
    if (params.charRealm && params.charName) {
        searchParams.set('charRealm', params.charRealm);
        searchParams.set('charName', params.charName);
    }

    const res = await fetch(`/api/craft?${searchParams}`, {
        next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export interface CharacterProfessionTier {
    tier_id: number | null;
    tier_name: string | null;
    skill_points: number | null;
    max_skill_points: number | null;
    known_recipe_count: number;
}

export interface CharacterProfessions {
    character: { name: string; realm_slug: string; region: string };
    professions: {
        profession_id: number | null;
        profession_name: string | null;
        tiers: CharacterProfessionTier[];
    }[];
    known_recipe_ids: number[];
    generated_at: string;
}

export interface RealmSlugEntry {
    slug: string;
    name: string;
    connected_realm_id: number;
}

export async function fetchCharacter(realmSlug: string, name: string): Promise<CharacterProfessions> {
    const searchParams = new URLSearchParams({ realm: realmSlug, name });
    const res = await fetch(`/api/character?${searchParams}`, { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `API error: ${res.status}`);
    return body;
}

export async function fetchRealmList(): Promise<RealmSlugEntry[]> {
    const res = await fetch(`/api/realm-list`, { next: { revalidate: 3600 } });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// --- Implied constrained-material ("lumber") valuation ---
// Data classifications surfaced by the API:
//   OBSERVED_LISTING | DERIVED | MODELED | CURATED_SOURCE | USER_PROVIDED

export interface MaterialInfo {
    material_key: string;
    display_name: string;
    material_type: string;
    is_tradeable: boolean;
    is_account_bound: boolean;
}

export interface LumberAssumptions {
    formula_version: string;
    realized_price_factor: number;
    ah_cut: number;
    deposit_loss_rate: number;
    seller_capture_factor: number;
    max_input_age_hours: number;
    min_listing_count: number;
    min_listed_quantity: number;
    max_cross_realm_multiplier: number;
    min_eligible_recipes: number;
    reference_aggregation: string;
    conservative_percentile: number;
}

export interface DecorConversionRow {
    decor_item: {
        item_id: number;
        name: string | null;
        quality: string | null;
        icon_url: string | null;
    };
    recipe: {
        id: number;
        name: string | null;
        external_key: string;
        crafting_system: string | null;
        verification_status: string;
        source_version: string | null;
    };
    realm_name: string | null;
    connected_realm_id: number;
    listing_median: number | null;
    listing_min: number | null;
    listing_count: number | null;
    listed_quantity: number | null;
    listing_updated_at: string | null;
    estimated_realized_unit_price: number | null;
    crafted_quantity: number | null;
    gross_estimated_revenue: number | null;
    net_estimated_revenue: number | null;
    expected_deposit_loss: number | null;
    other_reagent_cost: number | null;
    material_quantity: number | null;
    implied_value_per_material: number | null;
    churn_rate: number | null;
    estimated_market_units_per_day: number | null;
    seller_capture_factor: number | null;
    estimated_capturable_units_per_day: number | null;
    expected_daily_contribution: number | null;
    freshness_score: number | null;
    liquidity_score: number | null;
    input_quality_score: number | null;
    model_quality: number | null;
    eligibility_status: 'ELIGIBLE' | 'EXCLUDED';
    exclusion_reasons: string[];
    input_snapshot: any;
    computed_at: string | null;
}

export type MaterialValueStatus =
    | 'ok' | 'insufficient_data' | 'no_data' | 'no_mapping'
    | 'unknown_material' | 'stale' | 'disabled';

export interface MaterialValueResponse {
    status: MaterialValueStatus;
    materials?: MaterialInfo[];
    material?: MaterialInfo;
    realm?: { connected_realm_id: number; name: string | null };
    scope?: 'realm';
    region?: string;
    reference_implied_value?: number | null;
    best_conversion_value?: number | null;
    conservative_implied_value?: number | null;
    eligible_recipe_count?: number;
    excluded_recipe_count?: number;
    model_quality?: number | null;
    weighted_freshness_score?: number | null;
    weighted_liquidity_score?: number | null;
    computed_at?: string | null;
    is_stale?: boolean;
    next_scheduled_refresh?: string;
    formula_version?: string;
    source_version?: string | null;
    assumptions?: LumberAssumptions;
    classifications?: Record<string, string>;
    top_conversions?: DecorConversionRow[];
}

export interface DecorOpportunitiesResponse {
    status: MaterialValueStatus;
    rows: DecorConversionRow[];
    total_returned: number;
    include_excluded: boolean;
    formula_version?: string;
    computed_at?: string | null;
}

export async function fetchMaterialValue(params: {
    material?: string;
    realm?: number;
    formulaVersion?: string;
}): Promise<MaterialValueResponse> {
    const sp = new URLSearchParams();
    if (params.material) sp.set('material', params.material);
    if (params.realm) sp.set('realm', String(params.realm));
    if (params.formulaVersion) sp.set('formula_version', params.formulaVersion);
    const res = await fetch(`/api/material-value?${sp}`, { next: { revalidate: 60 } });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `API error: ${res.status}`);
    return body;
}

export async function fetchDecorOpportunities(params: {
    material: string;
    realm: number;
    sort?: string;
    limit?: number;
    offset?: number;
    includeExcluded?: boolean;
}): Promise<DecorOpportunitiesResponse> {
    const sp = new URLSearchParams({ material: params.material, realm: String(params.realm) });
    if (params.sort) sp.set('sort', params.sort);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.offset) sp.set('offset', String(params.offset));
    if (params.includeExcluded) sp.set('include_excluded', '1');
    const res = await fetch(`/api/decor-opportunities?${sp}`, { next: { revalidate: 60 } });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `API error: ${res.status}`);
    return body;
}

export async function fetchHealth(): Promise<HealthResponse> {
    const res = await fetch(`/api/health`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// --- Formatting helpers ---

/** Convert copper amount to gold/silver/copper string */
export function formatGold(copper: number | null): { gold: number; silver: number; copper: number } {
    if (!copper || copper <= 0) return { gold: 0, silver: 0, copper: 0 };
    const g = Math.floor(copper / 10000);
    const s = Math.floor((copper % 10000) / 100);
    const c = copper % 100;
    return { gold: g, silver: s, copper: c };
}

/** Compact gold string for table display: 1.23M / 234k / 12,345 (gold units) */
export function formatGoldCompact(copper: number): string {
    const g = copper / 10000;
    if (g >= 1_000_000) return `${(g / 1_000_000).toFixed(2)}M`;
    if (g >= 100_000) return `${Math.round(g / 1000)}k`;
    if (g >= 10_000) return `${(g / 1000).toFixed(1)}k`;
    return Math.round(g).toLocaleString();
}

/** Format a z-score with sign and 2 decimal places */
export function formatZ(z: number | null): string {
    if (z === null || z === undefined) return '--';
    const sign = z >= 0 ? '+' : '';
    return `${sign}${z.toFixed(2)}`;
}

/** Format percentage with sign */
export function formatPct(pct: number | null): string {
    if (pct === null || pct === undefined) return '--';
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${(pct * 100).toFixed(1)}%`;
}

/** Get CSS class for WoW item quality */
export function qualityColor(quality: string | null): string {
    if (!quality) return 'var(--quality-common)';
    const q = quality.toLowerCase();
    if (q === 'poor' || q === 'junk') return 'var(--quality-poor)';
    if (q === 'common') return 'var(--quality-common)';
    if (q === 'uncommon') return 'var(--quality-uncommon)';
    if (q === 'rare') return 'var(--quality-rare)';
    if (q === 'epic') return 'var(--quality-epic)';
    if (q === 'legendary') return 'var(--quality-legendary)';
    if (q === 'artifact') return 'var(--quality-artifact)';
    if (q === 'heirloom') return 'var(--quality-heirloom)';
    return 'var(--quality-common)';
}

/** Local-time label for the next scheduled data refresh (cron: 02/10/18 UTC) */
export function nextRefreshLabel(): string {
    const REFRESH_HOURS_UTC = [2, 10, 18];
    const now = new Date();
    const next = new Date(now);
    const hour = now.getUTCHours();
    const nextHour = REFRESH_HOURS_UTC.find((h) => h > hour);
    if (nextHour !== undefined) {
        next.setUTCHours(nextHour, 0, 0, 0);
    } else {
        next.setUTCDate(next.getUTCDate() + 1);
        next.setUTCHours(REFRESH_HOURS_UTC[0], 0, 0, 0);
    }
    return next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Relative time string */
export function timeAgo(dateStr: string | null): string {
    if (!dateStr) return 'unknown';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}
