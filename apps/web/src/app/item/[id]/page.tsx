'use client';

import React, { useState, useEffect } from 'react';
import {
    ItemDetailResponse,
    RealmEntry,
    fetchItemDetail,
    fetchRealms,
    formatGold,
    formatZ,
    formatPct,
    qualityColor,
    timeAgo,
} from '@/lib/api';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Cell,
    LabelList,
    AreaChart,
    Area,
    LineChart,
    Line,
} from 'recharts';

// --- Gold Amount Component ---
function GoldAmount({ copper }: { copper: number | null }) {
    if (!copper || copper <= 0) return <span style={{ color: 'var(--text-muted)' }}>--</span>;
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

// --- Sparkline Tooltip ---
function SparklineTooltip({ active, payload, label, valueKey, format }: any) {
    if (!active || !payload?.length) return null;
    const value = payload[0]?.value;
    return (
        <div
            style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 12px',
                fontSize: '0.78rem',
            }}
        >
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
            <div style={{ fontWeight: 600 }}>
                {format === 'gold' ? <GoldAmount copper={value} /> : value?.toFixed(4)}
            </div>
        </div>
    );
}

export default function ItemDetailPage({ params }: { params: { id: string } }) {
    const itemId = parseInt(params.id, 10);
    const [data, setData] = useState<ItemDetailResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedRealm, setSelectedRealm] = useState<number | undefined>();
    const [days, setDays] = useState(14);
    const [realms, setRealms] = useState<RealmEntry[]>([]);
    const [lbSortKey, setLbSortKey] = useState<string>('sell_suitability_score');
    const [lbSortDir, setLbSortDir] = useState<'asc' | 'desc'>('desc');

    const toggleLbSort = (key: string) => {
        if (lbSortKey === key) {
            setLbSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setLbSortKey(key);
            setLbSortDir('desc');
        }
    };

    const sortedLeaderboard = data?.realm_leaderboard ? [...data.realm_leaderboard].sort((a: any, b: any) => {
        const av = a[lbSortKey];
        const bv = b[lbSortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return lbSortDir === 'asc' ? av - bv : bv - av;
    }) : [];

    useEffect(() => {
        fetchRealms().then(setRealms).catch(() => { });
    }, []);

    useEffect(() => {
        setLoading(true);
        setError(null);
        fetchItemDetail(itemId, selectedRealm, days)
            .then(setData)
            .catch((err) => setError(err.message))
            .finally(() => setLoading(false));
    }, [itemId, selectedRealm, days]);

    // Prepare chart data — data is per-realm, not time-series
    // We need to look up realm names for x-axis labels
    const realmNameMap = new Map(realms.map(r => [r.connected_realm_id, r.name]));
    const chartData = (data?.time_series || [])
        .sort((a, b) => (b.median_buyout ?? 0) - (a.median_buyout ?? 0))
        .map((pt) => {
            const realmId = (pt as any).connected_realm_id;
            return {
                realm: realmNameMap.get(realmId) ?? (realmId ? `Realm ${realmId}` : ''),
                price: pt.median_buyout,
                priceGold: pt.median_buyout ? pt.median_buyout / 10000 : null,
                demand: pt.demand_proxy_smoothed,
                listings: pt.listing_count,
                quantity: pt.total_quantity,
            };
        });

    // Daily time-series data (for trend charts)
    const dailyData = (data?.daily_time_series || []).map((pt: any) => ({
        date: typeof pt.date === 'string' ? pt.date.slice(5) : pt.date, // "MM-DD"
        price: pt.median_price,
        priceGold: pt.median_price ? pt.median_price / 10000 : 0,
        demand: pt.demand_proxy,
        listings: pt.listing_count,
    }));

    // Gold formatting helper for Y-axis
    const formatGoldAxis = (copper: number) => {
        const g = Math.floor(copper / 10000);
        const s = Math.floor((copper % 10000) / 100);
        if (g >= 1000) return `${(g / 1000).toFixed(g >= 10000 ? 0 : 1)}k`;
        if (g > 0) return `${g}g`;
        if (s > 0) return `${s}s`;
        return `${copper}c`;
    };

    // Gold formatting helper for text display (e.g. "12g 34s")
    const formatGoldStr = (copper: number | null) => {
        if (!copper || copper <= 0) return '0g';
        const g = Math.floor(copper / 10000);
        const s = Math.floor((copper % 10000) / 100);
        if (g >= 1000) return `${(g / 1000).toFixed(g >= 10000 ? 0 : 1)}k gold`;
        if (g > 0 && s > 0) return `${g}g ${s}s`;
        if (g > 0) return `${g}g`;
        if (s > 0) return `${s}s`;
        return `${copper}c`;
    };

    if (loading) {
        return (
            <div className="page-container">
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                    Loading item details...
                </div>
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="page-container">
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--accent-red)' }}>
                    {error || 'Item not found'}
                </div>
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                    <a href="/" className="btn btn-secondary">Back to Radar</a>
                </div>
            </div>
        );
    }

    const item = data.item;

    return (
        <div className="page-container">
            {/* Back link */}
            <a
                href="/"
                style={{
                    color: 'var(--accent-gold)',
                    textDecoration: 'none',
                    fontSize: '0.85rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    marginBottom: 16,
                }}
            >
                ← Back to Hot Items Radar
            </a>

            {/* Item Header */}
            <div
                className="glass-card fade-in"
                style={{ padding: 24, marginBottom: 24 }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    {item.icon_url ? (
                        <img
                            src={item.icon_url}
                            alt=""
                            style={{
                                width: 56,
                                height: 56,
                                borderRadius: 8,
                                border: `2px solid ${qualityColor(item.quality)}`,
                            }}
                        />
                    ) : (
                        <div
                            style={{
                                width: 56,
                                height: 56,
                                borderRadius: 8,
                                background: 'var(--bg-secondary)',
                                border: '2px solid var(--border-subtle)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.8rem',
                                color: 'var(--text-muted)',
                            }}
                        >
                            #{item.item_id}
                        </div>
                    )}
                    <div>
                        <h1
                            style={{
                                fontSize: '1.6rem',
                                fontWeight: 800,
                                color: qualityColor(item.quality),
                                margin: 0,
                            }}
                        >
                            {item.name ?? `Item #${item.item_id}`}
                        </h1>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: 2 }}>
                            {[item.item_class, item.item_subclass, item.level ? `iLvl ${item.level}` : null]
                                .filter(Boolean)
                                .join(' · ')}
                            {' · '}
                            ID: {item.item_id}
                            {' · '}
                            <a
                                href={`https://www.wowhead.com/item=${item.item_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: 'var(--accent-gold)', textDecoration: 'none' }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                Wowhead ↗
                            </a>
                        </div>
                    </div>
                </div>
            </div>

            {/* Filters */}
            <div className="filter-bar">
                <select
                    className="filter-select"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                >
                    <option value={7}>7 Days</option>
                    <option value={14}>14 Days</option>
                    <option value={30}>30 Days</option>
                </select>

                <select
                    className="filter-select"
                    value={selectedRealm ?? ''}
                    onChange={(e) => setSelectedRealm(e.target.value ? Number(e.target.value) : undefined)}
                >
                    <option value="">All Realms (aggregated)</option>
                    {realms.map((r) => (
                        <option key={r.connected_realm_id} value={r.connected_realm_id}>
                            {r.name}
                        </option>
                    ))}
                </select>
            </div>

            {/* Base Stats */}
            {data?.base_stats && (
                <div className="glass-card fade-in" style={{ padding: 20, marginBottom: 20 }}>
                    <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 14, color: 'var(--accent-gold)' }}>
                        Base Stats
                    </h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16, fontSize: '0.82rem' }}>
                        {data.base_stats.selected_realm && (
                            <>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Current Price</div>
                                    <div style={{ fontWeight: 700, color: 'var(--accent-gold)' }}>{formatGoldStr(data.base_stats.selected_realm.current_price)}</div>
                                </div>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Mean Price (Realm)</div>
                                    <div style={{ fontWeight: 600 }}>{formatGoldStr(data.base_stats.selected_realm.mean_price)}</div>
                                </div>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>EWMA Price (Realm)</div>
                                    <div style={{ fontWeight: 600 }}>{formatGoldStr(data.base_stats.selected_realm.ewma_price)}</div>
                                </div>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Available (Realm)</div>
                                    <div style={{ fontWeight: 600 }}>{data.base_stats.selected_realm.available.toLocaleString()} ({data.base_stats.selected_realm.listing_count} listings)</div>
                                </div>
                            </>
                        )}
                        {data.base_stats.all_realms && (
                            <>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Median Price (US)</div>
                                    <div style={{ fontWeight: 600, color: 'var(--accent-emerald)' }}>{formatGoldStr(data.base_stats.all_realms.median_price)}</div>
                                </div>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Mean Price (US)</div>
                                    <div style={{ fontWeight: 600, color: 'var(--accent-emerald)' }}>{formatGoldStr(data.base_stats.all_realms.mean_price)}</div>
                                </div>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Price Range (US)</div>
                                    <div style={{ fontWeight: 600 }}>{formatGoldStr(data.base_stats.all_realms.min_price)} – {formatGoldStr(data.base_stats.all_realms.max_price)}</div>
                                </div>
                                <div>
                                    <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Total Available (US)</div>
                                    <div style={{ fontWeight: 600 }}>{data.base_stats.all_realms.total_available.toLocaleString()} across {data.base_stats.all_realms.realm_count} realms</div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Charts */}
            <div className="sparkline-container" style={{ marginBottom: 24 }}>
                {/* Price & Quantity by Realm — Combined Horizontal Bar Chart */}
                <div className="glass-card sparkline-card fade-in">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                        <h3 style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--accent-gold)', margin: 0 }}>
                            Price & Quantity by Realm
                        </h3>
                        {/* Chart legend — at top for immediate context */}
                        <div style={{ display: 'flex', gap: 14, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--accent-gold)', borderRadius: 2, marginRight: 4 }} />Price</span>
                            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'rgba(168, 85, 247, 0.7)', borderRadius: 2, marginRight: 4 }} />Quantity</span>
                            {selectedRealm != null && <span><span style={{ display: 'inline-block', width: 10, height: 10, border: '1.5px dashed #fff', borderRadius: 2, marginRight: 4 }} />Selected</span>}
                        </div>
                    </div>
                    {chartData.length > 0 ? (
                        <div style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'hidden' }}>
                            <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 28 + 40)}>
                                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 70, top: 0, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
                                    <XAxis
                                        type="number"
                                        tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                                        tickLine={false}
                                        tickFormatter={(v: number) => formatGoldAxis(v)}
                                        xAxisId="price"
                                    />
                                    <XAxis
                                        type="number"
                                        tick={false}
                                        tickLine={false}
                                        axisLine={false}
                                        xAxisId="quantity"
                                        orientation="top"
                                        hide
                                    />
                                    <YAxis
                                        type="category"
                                        dataKey="realm"
                                        tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                                        tickLine={false}
                                        width={100}
                                    />
                                    <Tooltip
                                        content={(props: any) => {
                                            const { active, payload } = props;
                                            if (!active || !payload?.length) return null;
                                            const d = payload[0]?.payload;
                                            return (
                                                <div className="glass-card" style={{ padding: '8px 12px', fontSize: '0.78rem' }}>
                                                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{d?.realm}</div>
                                                    <div style={{ color: 'var(--accent-gold)' }}>Price: {d?.price ? formatGoldStr(d.price) : '—'}</div>
                                                    <div style={{ color: 'var(--accent-purple)' }}>Quantity: {d?.quantity?.toLocaleString() ?? '—'}</div>
                                                </div>
                                            );
                                        }}
                                    />
                                    <Bar dataKey="price" radius={[0, 3, 3, 0]} barSize={12} xAxisId="price">
                                        {chartData.map((_entry, idx) => {
                                            const isSelectedRealm = selectedRealm != null && _entry.realm === realmNameMap.get(selectedRealm);
                                            const opacity = isSelectedRealm ? 1 : 0.6 - (idx / Math.max(chartData.length, 1)) * 0.3;
                                            return <Cell key={`price-${idx}`} fill={isSelectedRealm ? 'rgba(255, 215, 0, 1)' : `rgba(255, 215, 0, ${opacity})`} stroke={isSelectedRealm ? '#fff' : 'none'} strokeWidth={isSelectedRealm ? 1.5 : 0} strokeDasharray={isSelectedRealm ? '4 2' : 'none'} />;
                                        })}
                                        <LabelList
                                            dataKey="price"
                                            position="right"
                                            formatter={(v: number) => formatGoldAxis(v)}
                                            style={{ fontSize: 9, fill: 'var(--text-secondary)', fontWeight: 600 }}
                                        />
                                    </Bar>
                                    <Bar dataKey="quantity" radius={[0, 3, 3, 0]} barSize={8} xAxisId="quantity" opacity={0.7}>
                                        {chartData.map((_entry, idx) => {
                                            const isSelectedRealm = selectedRealm != null && _entry.realm === realmNameMap.get(selectedRealm);
                                            return <Cell key={`qty-${idx}`} fill={isSelectedRealm ? 'rgba(168, 85, 247, 1)' : 'rgba(168, 85, 247, 0.45)'} stroke={isSelectedRealm ? '#fff' : 'none'} strokeWidth={isSelectedRealm ? 1 : 0} />;
                                        })}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    ) : (
                        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            No price data available
                        </div>
                    )}
                </div>

                {/* Price Trend — Daily Line Chart */}
                <div className="glass-card sparkline-card fade-in">
                    <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 12, color: 'var(--accent-gold)' }}>
                        Price Trend (Daily)
                    </h3>
                    {dailyData.length > 1 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <AreaChart data={dailyData}>
                                <defs>
                                    <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="var(--accent-gold)" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="var(--accent-gold)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                                <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} tickLine={false} />
                                <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} tickLine={false} tickFormatter={(v: number) => formatGoldAxis(v)} />
                                <Tooltip content={(props: any) => <SparklineTooltip {...props} format="gold" />} />
                                <Area type="monotone" dataKey="price" stroke="var(--accent-gold)" fill="url(#priceGrad)" strokeWidth={2} dot={{ r: 3, fill: 'var(--accent-gold)' }} />
                            </AreaChart>
                        </ResponsiveContainer>
                    ) : (
                        <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', padding: '0 16px' }}>
                            Trend data requires 2+ days of ingestion.<br />Check back tomorrow!
                        </div>
                    )}
                </div>
            </div>

            {/* Demand Trend — Daily */}
            <div className="glass-card fade-in" style={{ padding: 24, marginBottom: 24 }}>
                <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 12, color: 'var(--accent-purple)' }}>
                    Demand Trend (Daily)
                </h3>
                {dailyData.length > 1 ? (
                    <ResponsiveContainer width="100%" height={220}>
                        <AreaChart data={dailyData}>
                            <defs>
                                <linearGradient id="demandGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="var(--accent-purple)" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="var(--accent-purple)" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                            <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} tickLine={false} />
                            <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} />
                            <Tooltip content={(props: any) => <SparklineTooltip {...props} format="number" />} />
                            <Area type="monotone" dataKey="demand" stroke="var(--accent-purple)" fill="url(#demandGrad)" strokeWidth={2} dot={{ r: 3, fill: 'var(--accent-purple)' }} />
                        </AreaChart>
                    </ResponsiveContainer>
                ) : (
                    <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', padding: '0 16px' }}>
                        Trend data requires 2+ days of ingestion.<br />Check back tomorrow!
                    </div>
                )}
            </div>

            {/* Realm Leaderboard */}
            <div className="glass-card fade-in" style={{ padding: 24 }}>
                <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 16 }}>
                    Realm Leaderboard — Best Places to Sell
                </h3>
                {sortedLeaderboard.length > 0 ? (
                    <div className="data-table-wrapper" style={{ border: 'none' }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    {[
                                        { key: 'realm_name', label: 'Realm' },
                                        { key: 'current_price', label: 'Price' },
                                        { key: 'total_quantity', label: 'Qty' },
                                        { key: 'price_z', label: 'Price Z' },
                                        { key: 'demand_z', label: 'Demand Z' },
                                        { key: 'sell_suitability_score', label: 'Sell Suitability' },
                                        { key: 'confidence', label: 'Confidence' },
                                    ].map(col => (
                                        <th
                                            key={col.key}
                                            onClick={() => toggleLbSort(col.key)}
                                            style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                                        >
                                            {col.label}
                                            {lbSortKey === col.key && (
                                                <span style={{ marginLeft: 4, fontSize: '0.7rem' }}>
                                                    {lbSortDir === 'asc' ? '▲' : '▼'}
                                                </span>
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {sortedLeaderboard.map((r, i) => {
                                    const realmTooltip = r.connected_realm_names && r.realm_count > 1
                                        ? `Connected realms: ${r.connected_realm_names}`
                                        : undefined;
                                    return (
                                        <tr key={r.connected_realm_id}>
                                            <td style={{ color: i < 3 ? 'var(--accent-gold)' : 'var(--text-muted)', fontWeight: 700 }}>
                                                {i + 1}
                                            </td>
                                            <td style={{ fontWeight: 500 }} title={realmTooltip}>
                                                {r.realm_name ?? `Realm ${r.connected_realm_id}`}
                                                {r.realm_count > 1 && (
                                                    <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 4 }}>({r.realm_count})</span>
                                                )}
                                            </td>
                                            <td>
                                                <GoldAmount copper={r.current_price} />
                                            </td>
                                            <td style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                                                {r.total_quantity != null ? r.total_quantity.toLocaleString() : '—'}
                                            </td>
                                            <td>
                                                <span className={`stat-badge ${(r.price_z ?? 0) > 0 ? 'positive' : (r.price_z ?? 0) < 0 ? 'negative' : 'neutral'}`}>
                                                    {formatZ(r.price_z)}
                                                </span>
                                            </td>
                                            <td>
                                                <span className={`stat-badge ${(r.demand_z ?? 0) > 0 ? 'positive' : (r.demand_z ?? 0) < 0 ? 'negative' : 'neutral'}`}>
                                                    {formatZ(r.demand_z)}
                                                </span>
                                            </td>
                                            <td>
                                                <span style={{ fontWeight: 700, color: (r.sell_suitability_score ?? 0) > 1 ? 'var(--accent-gold)' : 'var(--text-primary)' }}>
                                                    {r.sell_suitability_score != null ? r.sell_suitability_score.toFixed(2) : '--'}
                                                </span>
                                            </td>
                                            <td>
                                                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                                    {r.confidence != null ? ((r.confidence) * 100).toFixed(0) + '%' : '--'}
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>
                        No realm data available for this item.
                    </div>
                )}
            </div>

            {/* Footer */}
            <div
                style={{
                    marginTop: 16,
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    justifyContent: 'space-between',
                }}
            >
                <span>
                    Data window: {days} days. Generated: {new Date(data.generated_at).toLocaleString()}.
                </span>
                <span>
                    Timestamps shown in your local timezone.
                </span>
            </div>
        </div >
    );
}
