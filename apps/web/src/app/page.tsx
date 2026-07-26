'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
    HotItem,
    HotItemsResponse,
    RealmEntry,
    RealmSlugEntry,
    fetchHotItems,
    fetchRealmList,
    fetchRealms,
    formatGold,
    formatZ,
    formatPct,
    nextRefreshLabel,
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

// --- Sizzle Display ---
function SizzleDisplay({ score }: { score: number | null }) {
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

// --- Verdict chip: plain-language read of the price/demand stats ---
function RadarVerdict({ item }: { item: HotItem }) {
    const pz = item.price_z ?? 0;
    const dz = item.demand_z ?? 0;
    const stats = `Price ${pz >= 0 ? '+' : ''}${pz.toFixed(1)}σ, demand ${dz >= 0 ? '+' : ''}${dz.toFixed(1)}σ vs this item's own normal.`;
    let label: string, cls: string, advice: string;
    if (pz >= 2 && dz >= 0.5) {
        label = '🔥 Sell now'; cls = 'positive';
        advice = 'Price and demand are both well above normal — list your stock.';
    } else if (pz >= 2) {
        label = '💰 Price spike'; cls = 'positive';
        advice = 'Price is spiking without matching demand — sell into it before it corrects.';
    } else if (dz >= 1.5 && pz < 1) {
        label = '📈 Demand rising'; cls = 'positive';
        advice = 'Demand is climbing while price hasn’t moved yet — consider stocking up.';
    } else if (pz <= -1.5) {
        label = '🧊 Below normal'; cls = 'neutral';
        advice = 'Price is below its normal range — a chance to buy and hold.';
    } else {
        label = '➖ Steady'; cls = 'neutral';
        advice = 'Trading close to its normal range.';
    }
    return (
        <span className={`stat-badge ${cls}`} title={`${advice} ${stats}`} style={{ whiteSpace: 'nowrap' }}>
            {label}
        </span>
    );
}

// --- Column Sorting ---
type SortKey = 'sizzle' | 'price_z' | 'demand_z' | 'confidence' | 'price' | 'name';
type SortDir = 'asc' | 'desc';

function sortItems(items: HotItem[], sortKey: SortKey, sortDir: SortDir): HotItem[] {
    const sorted = [...items].sort((a, b) => {
        let va: number | string = 0;
        let vb: number | string = 0;
        switch (sortKey) {
            case 'sizzle':
                va = a.sizzle_score ?? -999;
                vb = b.sizzle_score ?? -999;
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
function HomePageInner() {
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
        (searchParams.get('sort') as SortKey) || 'sizzle'
    );
    const [sortDir, setSortDir] = useState<SortDir>(
        (searchParams.get('dir') as SortDir) || 'desc'
    );

    // Expandable alternate realms
    const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

    // Title animation — synced to GIF table flip at ~6.5s.
    // Plays once per session; subsequent loads show the title immediately.
    const [introState, setIntroState] = useState<'pending' | 'spin' | 'instant'>('pending');
    useEffect(() => {
        let played = false;
        try { played = !!sessionStorage.getItem('ftt-intro-played'); } catch { }
        if (played) {
            setIntroState('instant');
            return;
        }
        const timer = setTimeout(() => {
            setIntroState('spin');
            try { sessionStorage.setItem('ftt-intro-played', '1'); } catch { }
        }, 6500);
        return () => clearTimeout(timer);
    }, []);
    const titleVisible = introState !== 'pending';

    // Sync filter state to URL (so back-navigation preserves state)
    useEffect(() => {
        const params = new URLSearchParams();
        if (mode !== 'both') params.set('mode', mode);
        if (limit !== 50) params.set('limit', String(limit));
        if (minConfidence > 0) params.set('conf', String(minConfidence));
        if (selectedRealm) params.set('realm', String(selectedRealm));
        if (searchQuery) params.set('q', searchQuery);
        if (sortKey !== 'sizzle') params.set('sort', sortKey);
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

    // "My realm" quick filter — uses the character saved on the /craft page
    const [myRealm, setMyRealm] = useState<{ id: number; name: string; charName: string } | null>(null);
    useEffect(() => {
        let saved: { name?: string; realmSlug?: string } | null = null;
        try { saved = JSON.parse(localStorage.getItem('ftt-character') ?? 'null'); } catch { }
        if (!saved?.realmSlug || !saved?.name) return;
        fetchRealmList()
            .then((list: RealmSlugEntry[]) => {
                const entry = list.find(r => r.slug === saved!.realmSlug);
                if (entry) setMyRealm({ id: entry.connected_realm_id, name: entry.name, charName: saved!.name! });
            })
            .catch(() => { });
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <img src="/tableflip.gif" alt="Table flip!" style={{ height: '14.4rem', borderRadius: '4px' }} />
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <h1
                            className={`page-title ${introState === 'pending' ? 'title-hidden' : introState === 'spin' ? 'title-spin-in' : ''}`}
                        >
                            Flip the <svg className="table-icon" viewBox="0 0 30 26" width="28" height="24" style={{ display: 'inline-block', verticalAlign: '-4px', marginRight: '1px' }}><defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#f5a623" /><stop offset="100%" stopColor="#e07020" /></linearGradient></defs><polygon points="6,1 28,1 24,6 2,6" fill="url(#tg)" /><polygon points="2,6 6,1 6,3 2,7.5" fill="#c4861e" /><rect x="4" y="6" width="2.5" height="14" rx="0.5" fill="#2a1a0a" /><rect x="21" y="6" width="2.5" height="14" rx="0.5" fill="#2a1a0a" /><rect x="1" y="20" width="8" height="2.5" rx="1" fill="#1a1008" /><rect x="18" y="20" width="8" height="2.5" rx="1" fill="#1a1008" /></svg>able
                        </h1>
                        {titleVisible && (
                            <>
                                <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
                                    Furnish your Homestead for gold &mdash; flip furniture, stack gold, decorate later.
                                </p>
                                {data && (
                                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                        {data.region.toUpperCase()} &middot; {data.total_count} items &middot; {data.baseline_window_days}d baseline &middot; Updated {timeAgo(data.generated_at)} &middot; Next data ~{nextRefreshLabel()}
                                    </span>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Filters */}
            <div className="filter-bar">


                {myRealm && selectedRealm !== myRealm.id && (
                    <button
                        className="btn btn-secondary"
                        onClick={() => setSelectedRealm(myRealm.id)}
                        title={`Filter to ${myRealm.name} — ${myRealm.charName}'s realm`}
                    >
                        ⚔ My realm: {myRealm.name}
                    </button>
                )}

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

                <button className="btn btn-ghost" onClick={loadData} title="Re-fetch latest data from the server">
                    ↻ Refresh
                </button>

                <a
                    href="/craft"
                    className="btn btn-secondary"
                    style={{ marginLeft: 'auto', textDecoration: 'none' }}
                    title="Craft cost vs sell price margins for profession recipes"
                >
                    ⚒ Craftable Margins
                </a>
            </div>

            {/* Error */}
            {
                error && (
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
                )
            }

            {/* Loading overlay (shown when re-fetching with existing data) */}
            {
                loading && data && (
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
                )
            }

            {/* Loading skeleton (first load only) */}
            {
                loading && !data && (
                    <div className="data-table-wrapper">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    {['Item', 'Best Realm', 'Price', 'Qty', 'Price Dev', 'Demand Dev', 'Sizzle', 'Verdict', 'Confidence', 'Updated'].map(
                                        (h) => (
                                            <th key={h}>{h}</th>
                                        )
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {Array.from({ length: 10 }).map((_, i) => (
                                    <tr key={i}>
                                        {Array.from({ length: 10 }).map((_, j) => (
                                            <td key={j}>
                                                <div className="skeleton" style={{ height: 18, width: 60 + (i % 5) * 15 }} />
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            }

            {/* Data table */}
            {
                data && (
                    <div className="data-table-wrapper fade-in">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th onClick={() => handleSort('name')} className={sortKey === 'name' ? 'sorted' : ''} title="Item name and category">
                                        Item <SortIndicator column="name" />
                                    </th>
                                    <th title="The realm where this item has the highest sell suitability">Best Realm</th>
                                    <th onClick={() => handleSort('price')} className={sortKey === 'price' ? 'sorted' : ''} title="Current median buyout price on best realm">
                                        Price <SortIndicator column="price" />
                                    </th>
                                    <th title="Total quantity of this item listed on the best realm">Qty</th>
                                    <th onClick={() => handleSort('price_z')} className={sortKey === 'price_z' ? 'sorted' : ''} title="Z-score: how far the current price deviates from its historical mean">
                                        Price Dev <SortIndicator column="price_z" />
                                    </th>
                                    <th onClick={() => handleSort('demand_z')} className={sortKey === 'demand_z' ? 'sorted' : ''} title="Z-score: how far the current demand deviates from its historical mean">
                                        Demand Dev <SortIndicator column="demand_z" />
                                    </th>
                                    <th onClick={() => handleSort('sizzle')} className={sortKey === 'sizzle' ? 'sorted' : ''} title="Combined score = 0.65 × demand_z + 0.35 × price_z. Higher = more sizzle">
                                        Sizzle 🔥 <SortIndicator column="sizzle" />
                                    </th>
                                    <th title="Plain-language read of the price/demand stats — hover a chip for the reasoning">Verdict</th>
                                    <th onClick={() => handleSort('confidence')} className={sortKey === 'confidence' ? 'sorted' : ''} title="Data quality: based on snapshot count, listing volume, and price stability">
                                        Confidence <SortIndicator column="confidence" />
                                    </th>
                                    <th title="Time since last data update">Updated</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedItems.map((item, idx) => {
                                    const isExpanded = expandedItems.has(item.item.item_id);
                                    const connectedRealm = realms.find(r => r.connected_realm_id === item.best_realm.connected_realm_id);
                                    const realmTooltip = connectedRealm && connectedRealm.realm_count > 1 ? `Connected realms: ${connectedRealm.all_names.join(', ')}` : undefined;
                                    return (
                                        <React.Fragment key={`${item.item.item_id}-${item.best_realm.connected_realm_id}`}>
                                            <tr
                                                onClick={() => router.push(`/item/${item.item.item_id}`)}
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
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                <span
                                                                    className="item-name"
                                                                    style={{ color: qualityColor(item.item.quality) }}
                                                                >
                                                                    {item.item.name ?? `Item #${item.item.item_id}`}
                                                                </span>
                                                                <a
                                                                    href={`https://www.wowhead.com/item=${item.item.item_id}`}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    title="View on Wowhead"
                                                                    onClick={(e) => e.stopPropagation()}
                                                                    className="wh-link"
                                                                >
                                                                    <svg className="wh-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                                                        <polyline points="15 3 21 3 21 9" />
                                                                        <line x1="10" y1="14" x2="21" y2="3" />
                                                                    </svg>
                                                                    <span className="wh-text">Wowhead</span>
                                                                </a>
                                                            </div>
                                                            {item.item.item_subclass && (
                                                                <div className="item-id">{item.item.item_subclass}</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </td>

                                                {/* Best Realm */}
                                                <td>
                                                    <div style={{ fontWeight: 500 }} title={realmTooltip}>
                                                        {item.best_realm.realm_name ?? `Realm ${item.best_realm.connected_realm_id}`}
                                                        {connectedRealm && connectedRealm.realm_count > 1 && (
                                                            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 4 }}>({connectedRealm.realm_count})</span>
                                                        )}
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                                                        {item.alternate_realms.length > 0 && (
                                                            <button
                                                                style={{
                                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                                    fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent-gold)',
                                                                    background: isExpanded ? 'rgba(255, 215, 0, 0.12)' : 'rgba(255, 215, 0, 0.06)',
                                                                    border: '1px solid rgba(255, 215, 0, 0.25)', borderRadius: 6,
                                                                    padding: '2px 8px', cursor: 'pointer', userSelect: 'none',
                                                                    transition: 'all 0.15s ease',
                                                                }}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setExpandedItems(prev => {
                                                                        const next = new Set(prev);
                                                                        if (next.has(item.item.item_id)) next.delete(item.item.item_id);
                                                                        else next.add(item.item.item_id);
                                                                        return next;
                                                                    });
                                                                }}
                                                            >
                                                                <span style={{ fontSize: '0.8rem', lineHeight: 1 }}>{isExpanded ? '▾' : '▸'}</span>
                                                                +{item.alternate_realms.length} hot realms
                                                            </button>
                                                        )}
                                                        {item.total_realm_count > 0 && (
                                                            <span
                                                                style={{
                                                                    fontSize: '0.68rem', color: 'var(--text-muted)',
                                                                    cursor: 'pointer',
                                                                }}
                                                                onClick={(e) => { e.stopPropagation(); router.push(`/item/${item.item.item_id}`); }}
                                                                title={`View all ${item.total_realm_count} realms on item detail page`}
                                                            >
                                                                {item.total_realm_count} total realms →
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>

                                                {/* Price */}
                                                <td>
                                                    <GoldAmount copper={item.current_price} />
                                                </td>

                                                {/* Quantity */}
                                                <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                                                    {item.total_quantity != null ? item.total_quantity.toLocaleString() : '—'}
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
                                                    <SizzleDisplay score={item.sizzle_score} />
                                                </td>

                                                {/* Verdict */}
                                                <td>
                                                    <RadarVerdict item={item} />
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

                                            {/* Expandable alternate realm rows */}
                                            {isExpanded && item.alternate_realms.map((alt) => (
                                                <tr
                                                    key={`alt-${item.item.item_id}-${alt.connected_realm_id}`}
                                                    className="alt-realm-row"
                                                    style={{ background: 'rgba(255,255,255,0.02)', cursor: 'pointer' }}
                                                    onClick={() => router.push(`/item/${item.item.item_id}?realm=${alt.connected_realm_id}`)}
                                                >
                                                    <td></td>
                                                    <td style={{ paddingLeft: 20, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                                                        {alt.realm_name ?? `Realm ${alt.connected_realm_id}`}
                                                    </td>
                                                    <td>
                                                        <GoldAmount copper={alt.current_price} />
                                                    </td>
                                                    <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                                                        {alt.total_quantity != null ? alt.total_quantity.toLocaleString() : '—'}
                                                    </td>
                                                    <td>
                                                        <StatBadge value={alt.price_z} formatter={formatZ} />
                                                    </td>
                                                    <td>
                                                        <StatBadge value={alt.demand_z} formatter={formatZ} />
                                                    </td>
                                                    <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                                        {alt.sell_suitability_score != null ? alt.sell_suitability_score.toFixed(2) : '—'}
                                                    </td>
                                                    <td></td>
                                                    <td>
                                                        <ConfidenceBar value={alt.confidence} />
                                                    </td>
                                                    <td></td>
                                                </tr>
                                            ))}
                                        </React.Fragment>
                                    );
                                })}

                                {sortedItems.length === 0 && !loading && (
                                    <tr>
                                        <td colSpan={10} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                            No items found. Try adjusting filters, or run the ingest and compute jobs first.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )
            }

            {/* Footer info */}
            {
                data && (
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
                            Sizzle = 0.65 × demand_z + 0.35 × price_z.
                        </span>
                        <span>
                            Demand proxy: snapshot churn (EWMA-smoothed). Not actual sales data.
                        </span>
                    </div>
                )
            }
        </div >
    );
}

export default function HomePage() {
    return (
        <Suspense fallback={
            <div className="page-container">
                <div className="page-header">
                    <h1 className="page-title">Flip the Table</h1>
                </div>
                <div className="data-table-wrapper">
                    <table className="data-table">
                        <thead>
                            <tr>
                                {['Item', 'Best Realm', 'Price', 'Qty', 'Price Dev', 'Demand Dev', 'Sizzle', 'Verdict', 'Confidence', 'Updated'].map(
                                    (h) => <th key={h}>{h}</th>
                                )}
                            </tr>
                        </thead>
                        <tbody>
                            {Array.from({ length: 10 }).map((_, i) => (
                                <tr key={i}>
                                    {Array.from({ length: 10 }).map((_, j) => (
                                        <td key={j}>
                                            <div className="skeleton" style={{ height: 18, width: 60 + (i % 5) * 15 }} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        }>
            <HomePageInner />
        </Suspense>
    );
}
