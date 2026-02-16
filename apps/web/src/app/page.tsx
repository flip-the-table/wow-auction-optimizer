'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
    HotItem,
    HotItemsResponse,
    RealmEntry,
    fetchHotItems,
    fetchRealms,
    formatGold,
    formatZ,
    formatPct,
    qualityColor,
    timeAgo,
} from '@/lib/api';

// --- Gold Amount Component ---
function GoldAmount({ copper }: { copper: number | null }) {
    if (!copper || copper <= 0) return <span className="text-muted">--</span>;
    const { gold, silver, copper: cop } = formatGold(copper);
    return (
        <span className="gold-amount">
            {gold > 0 && (
                <>
                    <span>{gold.toLocaleString()}</span>
                    <span className="coin coin-gold" />
                </>
            )}
            {(gold > 0 || silver > 0) && (
                <>
                    <span>{silver}</span>
                    <span className="coin coin-silver" />
                </>
            )}
            <span>{cop}</span>
            <span className="coin coin-copper" />
        </span>
    );
}

// --- Stat Badge Component ---
function StatBadge({ value, formatter }: { value: number | null; formatter: (v: number | null) => string }) {
    const text = formatter(value);
    const cls = value === null ? 'neutral' : value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
    return <span className={`stat-badge ${cls}`}>{text}</span>;
}

// --- Confidence Bar ---
function ConfidenceBar({ value }: { value: number | null }) {
    const pct = Math.max(0, Math.min(100, (value ?? 0) * 100));
    const color =
        pct >= 70
            ? 'var(--accent-emerald)'
            : pct >= 40
                ? 'var(--accent-gold)'
                : 'var(--accent-red)';
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="confidence-bar">
                <div
                    className="confidence-bar-fill"
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {pct.toFixed(0)}%
            </span>
        </div>
    );
}

// --- Hotness Display ---
function HotnessDisplay({ score }: { score: number | null }) {
    if (score === null) return <span style={{ color: 'var(--text-muted)' }}>--</span>;
    // Normalize to 0-100 range for the bar (scores typically range -5 to 10)
    const normalizedPct = Math.max(0, Math.min(100, (score + 2) * 8));
    return (
        <div className="hotness-bar">
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 42, color: score > 2 ? 'var(--accent-gold)' : score > 0 ? 'var(--accent-emerald)' : 'var(--text-secondary)' }}>
                {score.toFixed(2)}
            </span>
            <div className="hotness-bar-track">
                <div className="hotness-bar-fill" style={{ width: `${normalizedPct}%` }} />
            </div>
        </div>
    );
}

// --- Column Sorting ---
type SortKey = 'hotness' | 'price_z' | 'demand_z' | 'confidence' | 'price' | 'name';
type SortDir = 'asc' | 'desc';

function sortItems(items: HotItem[], sortKey: SortKey, sortDir: SortDir): HotItem[] {
    const sorted = [...items].sort((a, b) => {
        let va: number | string = 0;
        let vb: number | string = 0;
        switch (sortKey) {
            case 'hotness':
                va = a.hotness_score ?? -999;
                vb = b.hotness_score ?? -999;
                break;
            case 'price_z':
                va = a.price_z ?? -999;
                vb = b.price_z ?? -999;
                break;
            case 'demand_z':
                va = a.demand_z ?? -999;
                vb = b.demand_z ?? -999;
                break;
            case 'confidence':
                va = a.confidence ?? 0;
                vb = b.confidence ?? 0;
                break;
            case 'price':
                va = a.current_price ?? 0;
                vb = b.current_price ?? 0;
                break;
            case 'name':
                va = a.item.name ?? `Item #${a.item.item_id}`;
                vb = b.item.name ?? `Item #${b.item.item_id}`;
                break;
        }
        if (typeof va === 'string' && typeof vb === 'string') {
            return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
    return sorted;
}

// --- Main Page ---
export default function HomePage() {
    const searchParams = useSearchParams();
    const router = useRouter();

    const [data, setData] = useState<HotItemsResponse | null>(null);
    const [realms, setRealms] = useState<RealmEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Initialize filters from URL search params
    const [mode, setMode] = useState<'both' | 'demand'>(
        (searchParams.get('mode') as 'both' | 'demand') || 'both'
    );
    const [minConfidence, setMinConfidence] = useState(
        Number(searchParams.get('conf')) || 0
    );
    const [selectedRealm, setSelectedRealm] = useState<number | undefined>(
        searchParams.get('realm') ? Number(searchParams.get('realm')) : undefined
    );
    const [searchQuery, setSearchQuery] = useState(
        searchParams.get('q') || ''
    );
    const [limit, setLimit] = useState(
        Number(searchParams.get('limit')) || 50
    );

    // Sorting
    const [sortKey, setSortKey] = useState<SortKey>(
        (searchParams.get('sort') as SortKey) || 'hotness'
    );
    const [sortDir, setSortDir] = useState<SortDir>(
        (searchParams.get('dir') as SortDir) || 'desc'
    );

    // Sync filter state to URL (so back-navigation preserves state)
    useEffect(() => {
        const params = new URLSearchParams();
        if (mode !== 'both') params.set('mode', mode);
        if (limit !== 50) params.set('limit', String(limit));
        if (minConfidence > 0) params.set('conf', String(minConfidence));
        if (selectedRealm) params.set('realm', String(selectedRealm));
        if (searchQuery) params.set('q', searchQuery);
        if (sortKey !== 'hotness') params.set('sort', sortKey);
        if (sortDir !== 'desc') params.set('dir', sortDir);
        const qs = params.toString();
        router.replace(qs ? `/?${qs}` : '/', { scroll: false });
    }, [mode, limit, minConfidence, selectedRealm, searchQuery, sortKey, sortDir, router]);

    // Search debounce
    const searchTimeoutRef = useRef<NodeJS.Timeout>();
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        searchTimeoutRef.current = setTimeout(() => {
            setDebouncedSearch(searchQuery);
        }, 300);
        return () => clearTimeout(searchTimeoutRef.current);
    }, [searchQuery]);

    // Fetch data
    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const result = await fetchHotItems({
                mode,
                limit,
                minConfidence,
                realm: selectedRealm,
                search: debouncedSearch || undefined,
            });
            setData(result);
        } catch (err: any) {
            setError(err.message || 'Failed to load data');
        } finally {
            setLoading(false);
        }
    }, [mode, limit, minConfidence, selectedRealm, debouncedSearch]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Fetch realms once
    useEffect(() => {
        fetchRealms()
            .then(setRealms)
            .catch(() => { }); // silently fail
    }, []);

    // Sort items
    const sortedItems = useMemo(() => {
        if (!data) return [];
        return sortItems(data.items, sortKey, sortDir);
    }, [data, sortKey, sortDir]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
        } else {
            setSortKey(key);
            setSortDir('desc');
        }
    };

    const SortIndicator = ({ column }: { column: SortKey }) => {
        if (sortKey !== column) return <span style={{ opacity: 0.3, marginLeft: 4 }}>&#x25B2;</span>;
        return <span style={{ marginLeft: 4, color: 'var(--accent-gold)' }}>{sortDir === 'desc' ? '▼' : '▲'}</span>;
    };

    return (
        <div className="page-container">
            {/* Header */}
            <div className="page-header">
                <h1 className="page-title">Hot Items Radar</h1>
                {data && (
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {data.region.toUpperCase()} &middot; {data.total_count} items &middot; {data.baseline_window_days}d baseline &middot; Updated {timeAgo(data.generated_at)}
                    </span>
                )}
            </div>
            <p className="page-subtitle">
                Items selling like hotcakes -- high demand, high price, across all realms.
            </p>

            {/* Filters */}
            <div className="filter-bar">
                <select
                    className="filter-select"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'both' | 'demand')}
                >
                    <option value="both">Mode: Demand + Price</option>
                    <option value="demand">Mode: Demand Only</option>
                </select>

                <select
                    className="filter-select"
                    value={selectedRealm ?? ''}
                    onChange={(e) => setSelectedRealm(e.target.value ? Number(e.target.value) : undefined)}
                >
                    <option value="">All Realms</option>
                    {realms.map((r) => (
                        <option key={r.connected_realm_id} value={r.connected_realm_id}>
                            {r.name} ({r.realm_count} realms)
                        </option>
                    ))}
                </select>

                <select
                    className="filter-select"
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                >
                    <option value={0}>Min Confidence: Any</option>
                    <option value={0.3}>Min Confidence: 30%</option>
                    <option value={0.5}>Min Confidence: 50%</option>
                    <option value={0.7}>Min Confidence: 70%</option>
                </select>

                <select
                    className="filter-select"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                >
                    <option value={25}>Show 25</option>
                    <option value={50}>Show 50</option>
                    <option value={100}>Show 100</option>
                    <option value={200}>Show 200</option>
                </select>

                <input
                    type="text"
                    className="filter-input"
                    placeholder="Search items..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ minWidth: 180 }}
                />

                <button className="btn btn-ghost" onClick={loadData} title="Refresh">
                    ↻ Refresh
                </button>
            </div>

            {/* Error */}
            {error && (
                <div
                    style={{
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px 16px',
                        marginBottom: 16,
                        color: 'var(--accent-red)',
                        fontSize: '0.85rem',
                    }}
                >
                    {error} -- Make sure the API is running and data has been ingested.
                </div>
            )}

            {/* Loading overlay (shown when re-fetching with existing data) */}
            {loading && data && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 50,
                    background: 'rgba(10, 14, 24, 0.6)',
                    backdropFilter: 'blur(4px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'column', gap: 12,
                }}>
                    <div className="loading-spinner" />
                    <span style={{ color: 'var(--accent-gold)', fontSize: '0.9rem', fontWeight: 600 }}>
                        Loading items...
                    </span>
                </div>
            )}

            {/* Loading skeleton (first load only) */}
            {loading && !data && (
                <div className="data-table-wrapper">
                    <table className="data-table">
                        <thead>
                            <tr>
                                {['Item', 'Best Realm', 'Price', 'Price Dev', 'Demand Dev', 'Hotness', 'Confidence', 'Updated'].map(
                                    (h) => (
                                        <th key={h}>{h}</th>
                                    )
                                )}
                            </tr>
                        </thead>
                        <tbody>
                            {Array.from({ length: 10 }).map((_, i) => (
                                <tr key={i}>
                                    {Array.from({ length: 8 }).map((_, j) => (
                                        <td key={j}>
                                            <div className="skeleton" style={{ height: 18, width: 60 + (i % 5) * 15 }} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Data table */}
            {data && (
                <div className="data-table-wrapper fade-in">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th onClick={() => handleSort('name')} className={sortKey === 'name' ? 'sorted' : ''}>
                                    Item <SortIndicator column="name" />
                                </th>
                                <th>Best Realm</th>
                                <th onClick={() => handleSort('price')} className={sortKey === 'price' ? 'sorted' : ''}>
                                    Price <SortIndicator column="price" />
                                </th>
                                <th onClick={() => handleSort('price_z')} className={sortKey === 'price_z' ? 'sorted' : ''}>
                                    Price Dev <SortIndicator column="price_z" />
                                </th>
                                <th onClick={() => handleSort('demand_z')} className={sortKey === 'demand_z' ? 'sorted' : ''}>
                                    Demand Dev <SortIndicator column="demand_z" />
                                </th>
                                <th onClick={() => handleSort('hotness')} className={sortKey === 'hotness' ? 'sorted' : ''}>
                                    Hotness <SortIndicator column="hotness" />
                                </th>
                                <th onClick={() => handleSort('confidence')} className={sortKey === 'confidence' ? 'sorted' : ''}>
                                    Confidence <SortIndicator column="confidence" />
                                </th>
                                <th>Updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedItems.map((item, idx) => (
                                <tr
                                    key={`${item.item.item_id}-${item.best_realm.connected_realm_id}`}
                                    onClick={() => window.open(`/item/${item.item.item_id}`, '_self')}
                                    style={{ animationDelay: `${idx * 20}ms` }}
                                    className="fade-in"
                                >
                                    {/* Item cell */}
                                    <td>
                                        <div className="item-cell">
                                            {item.item.icon_url ? (
                                                <img
                                                    src={item.item.icon_url}
                                                    alt=""
                                                    className="item-icon"
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <div className="item-icon-placeholder">
                                                    {item.item.item_id}
                                                </div>
                                            )}
                                            <div>
                                                <div
                                                    className="item-name"
                                                    style={{ color: qualityColor(item.item.quality) }}
                                                >
                                                    {item.item.name ?? `Item #${item.item.item_id}`}
                                                </div>
                                                {item.item.item_subclass && (
                                                    <div className="item-id">{item.item.item_subclass}</div>
                                                )}
                                            </div>
                                        </div>
                                    </td>

                                    {/* Best Realm */}
                                    <td>
                                        <div style={{ fontWeight: 500 }}>
                                            {item.best_realm.realm_name ?? `Realm ${item.best_realm.connected_realm_id}`}
                                        </div>
                                        {item.alternate_realms.length > 0 && (
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                                +{item.alternate_realms.length} alt
                                            </div>
                                        )}
                                    </td>

                                    {/* Price */}
                                    <td>
                                        <GoldAmount copper={item.current_price} />
                                    </td>

                                    {/* Price Deviation */}
                                    <td>
                                        <StatBadge value={item.price_z} formatter={formatZ} />
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                            {formatPct(item.price_pct_diff)}
                                        </div>
                                    </td>

                                    {/* Demand Deviation */}
                                    <td>
                                        <StatBadge value={item.demand_z} formatter={formatZ} />
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                            {formatPct(item.demand_pct_diff)}
                                        </div>
                                    </td>

                                    {/* Hotness */}
                                    <td>
                                        <HotnessDisplay score={item.hotness_score} />
                                    </td>

                                    {/* Confidence */}
                                    <td>
                                        <ConfidenceBar value={item.confidence} />
                                    </td>

                                    {/* Updated */}
                                    <td style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                                        {timeAgo(item.updated_at)}
                                    </td>
                                </tr>
                            ))}

                            {sortedItems.length === 0 && !loading && (
                                <tr>
                                    <td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No items found. Try adjusting filters, or run the ingest and compute jobs first.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Footer info */}
            {data && (
                <div
                    style={{
                        marginTop: 16,
                        padding: '12px 0',
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        borderTop: '1px solid var(--border-subtle)',
                    }}
                >
                    <span>
                        Baselines computed over {data.baseline_window_days}-day rolling window using median + MAD.
                        Hotness = {data.mode === 'both' ? '0.65 * demand_z + 0.35 * price_z' : 'demand_z'}.
                    </span>
                    <span>
                        Demand proxy: snapshot churn (EWMA-smoothed). Not actual sales data.
                    </span>
                </div>
            )}
        </div>
    );
}
