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

    // Gold formatting helper for Y-axis
    const formatGoldAxis = (copper: number) => {
        const g = Math.floor(copper / 10000);
        const s = Math.floor((copper % 10000) / 100);
        if (g >= 1000) return `${(g / 1000).toFixed(0)}kg`;
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

            {/* Charts */}
            <div className="sparkline-container" style={{ marginBottom: 24 }}>
                {/* Price by Realm — Compact Horizontal Bar Chart */}
                <div className="glass-card sparkline-card fade-in">
                    <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 12, color: 'var(--accent-gold)' }}>
                        Price by Realm
                    </h3>
                    {chartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 22 + 30)}>
                            <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 60, top: 0, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" horizontal={false} />
                                <XAxis
                                    type="number"
                                    tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                                    tickLine={false}
                                    tickFormatter={(v: number) => formatGoldAxis(v)}
                                />
                                <YAxis
                                    type="category"
                                    dataKey="realm"
                                    tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
                                    tickLine={false}
                                    width={95}
                                />
                                <Tooltip content={(props: any) => <SparklineTooltip {...props} format="gold" />} />
                                <Bar dataKey="price" radius={[0, 3, 3, 0]} barSize={14}>
                                    {chartData.map((_entry, idx) => {
                                        const opacity = 1 - (idx / Math.max(chartData.length, 1)) * 0.5;
                                        return <Cell key={idx} fill={`rgba(255, 215, 0, ${opacity})`} />;
                                    })}
                                    <LabelList
                                        dataKey="price"
                                        position="right"
                                        formatter={(v: number) => formatGoldAxis(v)}
                                        style={{ fontSize: 9, fill: 'var(--text-secondary)', fontWeight: 600 }}
                                    />
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    ) : (
                        <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            No price data available
                        </div>
                    )}
                </div>

                {/* Demand by Realm — Area Chart */}
                <div className="glass-card sparkline-card fade-in">
                    <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 12, color: 'var(--accent-purple)' }}>
                        Demand by Realm (Smoothed Churn)
                    </h3>
                    {chartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={220}>
                            <AreaChart data={chartData}>
                                <defs>
                                    <linearGradient id="demandGrad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="var(--accent-purple)" stopOpacity={0.3} />
                                        <stop offset="95%" stopColor="var(--accent-purple)" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                                <XAxis
                                    dataKey="realm"
                                    tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                                    tickLine={false}
                                    angle={-35}
                                    textAnchor="end"
                                    height={55}
                                    interval={Math.max(0, Math.floor(chartData.length / 10) - 1)}
                                />
                                <YAxis
                                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                                    tickLine={false}
                                />
                                <Tooltip content={(props: any) => <SparklineTooltip {...props} format="number" />} />
                                <Area
                                    type="monotone"
                                    dataKey="demand"
                                    stroke="var(--accent-purple)"
                                    fill="url(#demandGrad)"
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4, fill: 'var(--accent-purple)' }}
                                />
                            </AreaChart>
                        </ResponsiveContainer>
                    ) : (
                        <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            No demand data available
                        </div>
                    )}
                </div>
            </div>

            {/* Realm Leaderboard */}
            <div className="glass-card fade-in" style={{ padding: 24 }}>
                <h3 style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: 16 }}>
                    Realm Leaderboard -- Best Places to Sell
                </h3>
                {data.realm_leaderboard.length > 0 ? (
                    <div className="data-table-wrapper" style={{ border: 'none' }}>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Realm</th>
                                    <th>Price</th>
                                    <th>Price Z</th>
                                    <th>Demand Z</th>
                                    <th>Sell Suitability</th>
                                    <th>Confidence</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.realm_leaderboard.map((r, i) => (
                                    <tr key={r.connected_realm_id}>
                                        <td style={{ color: i < 3 ? 'var(--accent-gold)' : 'var(--text-muted)', fontWeight: 700 }}>
                                            {i + 1}
                                        </td>
                                        <td style={{ fontWeight: 500 }}>
                                            {r.realm_name ?? `Realm ${r.connected_realm_id}`}
                                        </td>
                                        <td>
                                            <GoldAmount copper={r.current_price} />
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
                                                {r.sell_suitability_score?.toFixed(2) ?? '--'}
                                            </span>
                                        </td>
                                        <td>
                                            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                                {((r.confidence ?? 0) * 100).toFixed(0)}%
                                            </span>
                                        </td>
                                    </tr>
                                ))}
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
