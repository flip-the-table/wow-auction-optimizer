// API client and shared types for the WoW Auction Optimizer frontend
// API routes are same-origin (Next.js API Route Handlers on Netlify)

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
    price_z: number | null;
    demand_z: number | null;
    sell_suitability_score: number | null;
    current_price: number | null;
    confidence: number | null;
}

export interface HotItem {
    item: ItemInfo;
    best_realm: RealmRecommendation;
    alternate_realms: RealmRecommendation[];
    current_price: number | null;
    current_demand: number | null;
    price_pct_diff: number | null;
    demand_pct_diff: number | null;
    price_z: number | null;
    demand_z: number | null;
    hotness_score: number | null;
    confidence: number | null;
    listing_count: number | null;
    total_quantity: number | null;
    baseline_window_days: number;
    updated_at: string | null;
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
