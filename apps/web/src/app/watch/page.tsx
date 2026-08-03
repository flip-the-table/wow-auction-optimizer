'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
    OpportunityRow,
    OpportunitiesResponse,
    RealmSlugEntry,
    fetchOpportunities,
    fetchRealmList,
    nextRefreshLabel,
    qualityColor,
    timeAgo,
} from '@/lib/api';
import { SiteNav, AgeMixBar, Gold } from '@/components/market-widgets';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CHARACTER_STORAGE_KEY = 'ftt-character';


// Where the current price sits inside its own 30-day range: a dot on a
// green→red track. Low = unusually cheap (buy side), high = sell zone.
function PricePositionGauge({ percentile }: { percentile: number | null }) {
    if (percentile == null) return null;
    const pct = Math.round(percentile * 100);
    return (
        <div
            className="price-gauge"
            title={`Current price is at the ${pct}th percentile of this item's own last 30 days on this realm — ${pct <= 30 ? 'unusually cheap' : pct >= 80 ? 'near the top of its range (sell zone)' : 'mid-range'}. Listing-derived, not a prediction.`}
        >
            <div className="price-gauge-track">
                <span className="price-gauge-dot" style={{ left: `calc(${pct}% - 4px)` }} />
            </div>
            <span className="price-gauge-label">{pct}p</span>
        </div>
    );
}

function TrendArrow({ value, label, invertGood }: { value: number | null; label: string; invertGood?: boolean }) {
    if (value == null) return <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>;
    const up = value > 0.02, down = value < -0.02;
    const good = invertGood ? down : up;
    const bad = invertGood ? up : down;
    const color = good ? 'var(--accent-emerald)' : bad ? 'var(--accent-red)' : 'var(--text-muted)';
    const arrow = up ? '▲' : down ? '▼' : '▬';
    return (
        <span
            style={{ color, fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            title={`${label}: ${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}% — average of the last 3 days vs the prior 4 days.`}
        >
            {arrow} {Math.abs(value * 100).toFixed(0)}%
        </span>
    );
}

function OpportunityVerdict({ row }: { row: OpportunityRow }) {
    const score = row.opportunity_score ?? 0;
    const pctl = row.price_percentile_30d ?? 0.5;
    const dSlope = row.demand_slope_7d ?? 0;
    const qSlope = row.supply_slope_7d ?? 0;
    const today = new Date().getDay();
    let label: string, cls: string, title: string;
    if (row.history_days < 14) {
        label = '🌱 Building history'; cls = 'neutral';
        title = 'Fewer than 14 days of price history — signals not yet reliable.';
    } else if (score >= 0.45 && pctl <= 0.5) {
        label = '🛒 Buy window'; cls = 'positive';
        title = 'Unusually cheap vs its own 30-day range while demand holds — a stock-up moment.';
    } else if (qSlope <= -0.15 && dSlope >= 0) {
        label = '📦 Supply squeeze'; cls = 'positive';
        title = 'Listed supply is shrinking while demand holds — price pressure building.';
    } else if (pctl >= 0.8 && dSlope >= 0) {
        label = '💰 Sell zone'; cls = 'positive';
        title = 'Price is near the top of its own 30-day range — a good moment to list stock.';
    } else if (score >= 0.25) {
        label = '👀 Watch'; cls = 'neutral';
        title = 'Mildly favorable signals — worth keeping an eye on.';
    } else {
        label = '💤 No signal'; cls = 'neutral';
        title = 'Trading inside its normal range with no notable momentum.';
    }
    const bestToday = row.best_sell_day != null && row.best_sell_day === today
        && (row.best_day_uplift ?? 0) >= 0.05 && row.history_days >= 28;
    return (
        <span className={`stat-badge ${cls}`} title={title} style={{ whiteSpace: 'nowrap' }}>
            {label}{bestToday ? ' ✨' : ''}
        </span>
    );
}

export default function WatchPage() {
    const router = useRouter();
    const [data, setData] = useState<OpportunitiesResponse | null>(null);
    const [realmList, setRealmList] = useState<RealmSlugEntry[]>([]);
    const [realm, setRealm] = useState<number | undefined>();
    const [sort, setSort] = useState('opportunity');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [myRealm, setMyRealm] = useState<{ id: number; name: string } | null>(null);

    useEffect(() => {
        fetchRealmList().then((list) => {
            setRealmList(list);
            try {
                const saved = JSON.parse(localStorage.getItem(CHARACTER_STORAGE_KEY) ?? 'null');
                const entry = saved?.realmSlug ? list.find(r => r.slug === saved.realmSlug) : undefined;
                if (entry) setMyRealm({ id: entry.connected_realm_id, name: entry.name });
            } catch { }
        }).catch(() => { });
    }, []);

    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            setData(await fetchOpportunities({ realm, sort, limit: 50 }));
        } catch (e: any) {
            setError(e.message || 'Failed to load');
        } finally {
            setLoading(false);
        }
    }, [realm, sort]);

    useEffect(() => { loadData(); }, [loadData]);

    return (
        <div className="page-container">
            <SiteNav />
            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>Opportunities</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0', maxWidth: 720 }}>
                        Decor markets trading below their own 30-day range, squeezing on supply, or
                        entering their weekly sell window &mdash; computed from each item&rsquo;s own listing history.
                    </p>
                    {data?.generated_at && (
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            Updated {timeAgo(data.generated_at)} &middot; Next data ~{nextRefreshLabel()}
                        </span>
                    )}
                </div>
            </div>

            <div className="filter-bar">
                {myRealm && realm !== myRealm.id && (
                    <button className="btn btn-secondary" onClick={() => setRealm(myRealm.id)}
                        title={`Filter to ${myRealm.name} — your character's realm`}>
                        ⚔ My realm: {myRealm.name}
                    </button>
                )}
                <select className="filter-select" value={realm ?? ''} onChange={(e) => setRealm(e.target.value ? Number(e.target.value) : undefined)}>
                    <option value="">All realms (best signals)</option>
                    {realmList.map(r => (
                        <option key={r.slug} value={r.connected_realm_id}>{r.name}</option>
                    ))}
                </select>
                <select className="filter-select" value={sort} onChange={(e) => setSort(e.target.value)}>
                    <option value="opportunity">Sort: Opportunity score</option>
                    <option value="cheapness">Sort: Cheapest vs 30d range</option>
                    <option value="demand_momentum">Sort: Demand momentum</option>
                    <option value="supply_squeeze">Sort: Supply squeeze</option>
                    <option value="sell_zone">Sort: Sell zone (price at top of range)</option>
                </select>
                <button className="btn btn-ghost" onClick={loadData}>↻ Refresh</button>
            </div>

            {error && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16, color: 'var(--accent-red)', fontSize: '0.85rem' }}>
                    {error}
                </div>
            )}

            {data?.status === 'no_data' && !loading && (
                <div className="glass-card" style={{ padding: 24, color: 'var(--text-secondary)' }}>
                    No opportunity signals yet for this selection — signals need at least 14 days of
                    price history and a live market with 3+ listings.
                </div>
            )}

            {data && data.rows.length > 0 && (
                <div className="data-table-wrapper fade-in" style={{ opacity: loading ? 0.6 : 1 }}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th title="Decor item and realm">Item</th>
                                <th title="Current listing median">Price</th>
                                <th title="Where the current price sits in this item's own 30-day range (0 = cheapest, 100 = most expensive)">30d position</th>
                                <th title="Price trend: last 3 days vs prior 4 days">Price 7d</th>
                                <th title="Churn-based demand trend (includes expirations/cancellations)">Demand 7d</th>
                                <th title="Listed supply trend — falling supply with steady demand builds price pressure">Supply 7d</th>
                                <th title="Weekday with the highest average price over this item's 90-day history (needs 4+ weeks to be meaningful)">Best day</th>
                                <th title="0.4 x cheapness + 0.3 x demand momentum + 0.3 x supply squeeze — listing-derived, not a prediction">Score</th>
                                <th>Verdict</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.rows.map((row) => (
                                <tr key={`${row.item.item_id}-${row.connected_realm_id}`}
                                    onClick={() => router.push(`/item/${row.item.item_id}?realm=${row.connected_realm_id}`)}
                                    style={{ cursor: 'pointer' }}>
                                    <td>
                                        <div className="item-cell">
                                            {row.item.icon_url
                                                ? <img src={row.item.icon_url} alt="" className="item-icon" loading="lazy" />
                                                : <div className="item-icon-placeholder">{row.item.item_id}</div>}
                                            <div>
                                                <span className="item-name" style={{ color: qualityColor(row.item.quality) }}>
                                                    {row.item.name ?? `Item #${row.item.item_id}`}
                                                </span>
                                                <div className="item-id">
                                                    {row.realm_name ?? `Realm ${row.connected_realm_id}`} · {row.listing_count ?? '—'} listings
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td>
                                        <Gold copper={row.current_price} />
                                        <AgeMixBar age={row.listing_age} />
                                    </td>
                                    <td><PricePositionGauge percentile={row.price_percentile_30d} /></td>
                                    <td><TrendArrow value={row.price_slope_7d} label="Price trend" /></td>
                                    <td>
                                        <TrendArrow value={row.demand_slope_7d} label="Demand trend (churn-based)" />
                                        {(row.removals_per_day ?? 0) > 0 && (
                                            <div style={{ fontSize: '0.66rem', color: 'var(--accent-emerald)' }}
                                                title="Listings removed before they could expire (sold or cancelled) — from auction-ID tracking">
                                                ⚡ {row.removals_per_day!.toFixed(1)}/day
                                            </div>
                                        )}
                                    </td>
                                    <td><TrendArrow value={row.supply_slope_7d} label="Supply trend" invertGood /></td>
                                    <td style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                        {row.best_sell_day != null && row.history_days >= 28 ? (
                                            <span title={`Averages ${((row.best_day_uplift ?? 0) * 100).toFixed(0)}% above this item's overall mean on ${DAY_NAMES[row.best_sell_day]}s (90-day history)`}>
                                                {DAY_NAMES[row.best_sell_day]}
                                                {row.best_day_uplift != null && row.best_day_uplift > 0 && (
                                                    <span style={{ color: 'var(--accent-gold)' }}> +{(row.best_day_uplift * 100).toFixed(0)}%</span>
                                                )}
                                            </span>
                                        ) : <span style={{ color: 'var(--text-muted)' }} title="Needs 4+ weeks of history">—</span>}
                                    </td>
                                    <td>
                                        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: (row.opportunity_score ?? 0) >= 0.45 ? 'var(--accent-gold)' : 'var(--text-secondary)' }}>
                                            {row.opportunity_score != null ? Math.max(0, Math.round(row.opportunity_score * 100)) : '—'}
                                        </span>
                                    </td>
                                    <td><OpportunityVerdict row={row} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div style={{ marginTop: 16, padding: '12px 0', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
                All signals derive from each item&rsquo;s own listing history on that realm (30/90-day windows).
                Demand is churn-based and can include expired or cancelled auctions; nothing here is a prediction
                or a confirmed sale.
            </div>
        </div>
    );
}
