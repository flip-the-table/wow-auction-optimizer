'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TimingResponse, TimingItem, fetchTiming, qualityColor, timeAgo, nextRefreshLabel } from '@/lib/api';
import { SiteNav, Gold } from '@/components/market-widgets';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pct = (rel: number | null | undefined) =>
    rel == null ? '—' : `${rel >= 1 ? '+' : ''}${((rel - 1) * 100).toFixed(1)}%`;

// --- 7-bar weekly rhythm spark (per item) -----------------------------------
function RhythmSpark({ item, todayDow }: { item: TimingItem; todayDow: number }) {
    const vals = item.profile;
    const known = vals.filter((v): v is number => v != null);
    if (known.length === 0) return null;
    const min = Math.min(...known);
    const max = Math.max(...known);
    const span = Math.max(max - min, 0.0001);
    return (
        <div className="rhythm" aria-label={`Weekly price rhythm; cheapest ${DAYS[item.buy_dow]}, dearest ${DAYS[item.sell_dow]}`}>
            {vals.map((v, d) => {
                const h = v == null ? 0 : 4 + ((v - min) / span) * 20; // 4-24px
                const cls =
                    d === item.sell_dow ? 'rhythm-bar sell'
                        : d === item.buy_dow ? 'rhythm-bar buy'
                            : 'rhythm-bar';
                return (
                    <span
                        key={d}
                        className={cls + (d === todayDow ? ' today' : '')}
                        style={{ height: `${h}px` }}
                        title={`${DAYS[d]}: ${pct(v)} vs the item's typical day${d === todayDow ? ' (today)' : ''}`}
                    />
                );
            })}
        </div>
    );
}

function DayChip({ dow, kind }: { dow: number; kind: 'buy' | 'sell' }) {
    return (
        <span
            className={`day-chip ${kind}`}
            title={kind === 'buy'
                ? `Historically this item's cheapest day — stock up on ${DAYS[dow]}s`
                : `Historically this item's dearest day — list on ${DAYS[dow]}s`}
        >
            <span aria-hidden>{kind === 'buy' ? '🌱' : '🌾'}</span> {DAYS_SHORT[dow]}
        </span>
    );
}

export default function TimingPage() {
    const router = useRouter();
    const [data, setData] = useState<TimingResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchTiming(40)
            .then(setData)
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const today = data?.today_dow ?? new Date().getUTCDay();

    const market = useMemo(() => {
        const rows = data?.market ?? [];
        if (rows.length === 0) return null;
        const devs = rows.map(r => r.rel_price - 1);
        const maxAbs = Math.max(...devs.map(Math.abs), 0.0001);
        let best = rows[0].dow, worst = rows[0].dow;
        for (const r of rows) {
            if (r.rel_price > rows.find(x => x.dow === best)!.rel_price) best = r.dow;
            if (r.rel_price < rows.find(x => x.dow === worst)!.rel_price) worst = r.dow;
        }
        return { rows, maxAbs, best, worst };
    }, [data]);

    const harvestToday = useMemo(
        () => (data?.items ?? []).filter(i => i.sell_dow === today).slice(0, 5),
        [data, today]
    );
    const plantToday = useMemo(
        () => (data?.items ?? []).filter(i => i.buy_dow === today).slice(0, 5),
        [data, today]
    );

    return (
        <div className="page-container">
            <SiteNav />

            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>📅 The Almanac</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0', maxWidth: 760 }}>
                        When to plant gold and when to harvest it &mdash; each item&rsquo;s weekly price
                        rhythm, measured from 90 days of its own listings. Buy the troughs, list the peaks.
                    </p>
                    <span style={{ display: 'block', minHeight: '1.2em', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {data?.generated_at
                            ? <>It&rsquo;s <strong style={{ color: 'var(--text-secondary)' }}>{DAYS[today]}</strong> (UTC) &middot; Updated {timeAgo(data.generated_at)} &middot; Next data ~{nextRefreshLabel()}</>
                            : ' '}
                    </span>
                </div>
            </div>

            {error && (
                <div className="glass-card" style={{ padding: 20, color: 'var(--accent-red)', fontSize: '0.85rem' }}>{error}</div>
            )}

            {loading && (
                <div className="glass-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                    Reading the weather&hellip;
                </div>
            )}

            {data?.status === 'no_data' && !loading && (
                <div className="glass-card" style={{ padding: '24px 28px', color: 'var(--text-secondary)', maxWidth: 720 }}>
                    <h3 style={{ color: 'var(--accent-gold)', margin: '0 0 8px' }}>The almanac is still being written</h3>
                    <p style={{ fontSize: '0.88rem', margin: 0 }}>
                        Weekly rhythms need a full profile (every weekday observed several times) plus a live
                        market signal. Profiles build automatically with each data refresh &mdash; check back
                        after the next one (~{nextRefreshLabel()}).
                    </p>
                </div>
            )}

            {market && data?.status === 'ok' && (
                <>
                    {/* --- The week ribbon ------------------------------------ */}
                    <div className="almanac-week fade-in">
                        {market.rows.map((r) => {
                            const dev = r.rel_price - 1;
                            const h = (Math.abs(dev) / market.maxAbs) * 26; // px, half-range
                            const isToday = r.dow === today;
                            return (
                                <div
                                    key={r.dow}
                                    className={'almanac-day' + (isToday ? ' today' : '')}
                                    title={`${DAYS[r.dow]}: decor prices average ${pct(r.rel_price)} vs the weekly norm${r.rel_demand != null ? `, buyer activity ${pct(r.rel_demand)}` : ''} — across ${r.items} tracked markets`}
                                >
                                    <span className="alm-day-name">{DAYS_SHORT[r.dow]}</span>
                                    <div className="alm-bar-wrap" aria-hidden>
                                        <span
                                            className={'alm-bar ' + (dev >= 0 ? 'up' : 'down')}
                                            style={dev >= 0
                                                ? { height: `${Math.max(h, 2)}px`, bottom: '50%' }
                                                : { height: `${Math.max(h, 2)}px`, top: '50%' }}
                                        />
                                        <span className="alm-midline" />
                                    </div>
                                    <span className={'alm-dev ' + (dev >= 0 ? 'up' : 'down')}>{pct(r.rel_price)}</span>
                                    <span className="alm-badge">
                                        {r.dow === market.best && <>🌾 harvest</>}
                                        {r.dow === market.worst && <>🌱 plant</>}
                                        {isToday && r.dow !== market.best && r.dow !== market.worst && <>today</>}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '6px 2px 18px' }}>
                        Bars show the whole decor market&rsquo;s average price vs its weekly norm &mdash;
                        <span style={{ color: '#d99a2b' }}> above</span> favors sellers,
                        <span style={{ color: '#6ea8fe' }}> below</span> favors buyers. Days in UTC.
                    </div>

                    {/* --- Today's plan --------------------------------------- */}
                    <div className="almanac-plan">
                        <div className="glass-card plan-card fade-in">
                            <h3 className="plan-title harvest">🌾 Harvest today</h3>
                            <p className="plan-sub">Items that historically peak on {DAYS[today]}s &mdash; list them now.</p>
                            {harvestToday.length ? harvestToday.map(i => (
                                <a key={i.item.item_id} className="plan-row" href={`/item/${i.item.item_id}`}>
                                    {i.item.icon_url && <img src={i.item.icon_url} alt="" className="item-icon" loading="lazy" />}
                                    <span className="plan-name" style={{ color: qualityColor(i.item.quality) }}>{i.item.name}</span>
                                    <span className="plan-meta">{i.realm_name} · <Gold copper={i.current_price} /></span>
                                    <span className="plan-uplift up">{pct(i.profile[i.sell_dow])} day</span>
                                </a>
                            )) : (
                                <p className="plan-empty">Nothing peaks on {DAYS[today]}s. Best harvest day this week: <strong>{DAYS[market.best]}</strong>.</p>
                            )}
                        </div>
                        <div className="glass-card plan-card fade-in">
                            <h3 className="plan-title plant">🌱 Plant today</h3>
                            <p className="plan-sub">Items that historically bottom out on {DAYS[today]}s &mdash; stock up now.</p>
                            {plantToday.length ? plantToday.map(i => (
                                <a key={i.item.item_id} className="plan-row" href={`/item/${i.item.item_id}`}>
                                    {i.item.icon_url && <img src={i.item.icon_url} alt="" className="item-icon" loading="lazy" />}
                                    <span className="plan-name" style={{ color: qualityColor(i.item.quality) }}>{i.item.name}</span>
                                    <span className="plan-meta">{i.realm_name} · <Gold copper={i.current_price} /></span>
                                    <span className="plan-uplift down">{pct(i.profile[i.buy_dow])} day</span>
                                </a>
                            )) : (
                                <p className="plan-empty">Nothing bottoms out on {DAYS[today]}s. Best planting day this week: <strong>{DAYS[market.worst]}</strong>.</p>
                            )}
                        </div>
                    </div>

                    {/* --- Timing table --------------------------------------- */}
                    <div className="data-table-wrapper fade-in">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th title="Ranked by weekly swing — the widest gap between cheapest and dearest day">Item</th>
                                    <th title="Current price on the realm with this item's strongest signal">Price</th>
                                    <th title="Relative price by weekday over 90 days — hover a bar for the day">Weekly rhythm</th>
                                    <th title="Historically the cheapest weekday">Buy on</th>
                                    <th title="Historically the dearest weekday">Sell on</th>
                                    <th title="Cheapest day to dearest day — your timing edge">Swing</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.items.map((i) => (
                                    <tr key={i.item.item_id} onClick={() => router.push(`/item/${i.item.item_id}`)} style={{ cursor: 'pointer' }}>
                                        <td>
                                            <div className="item-cell">
                                                {i.item.icon_url
                                                    ? <img src={i.item.icon_url} alt="" className="item-icon" loading="lazy" />
                                                    : <div className="item-icon-placeholder">{i.item.item_id}</div>}
                                                <div>
                                                    <span className="item-name" style={{ color: qualityColor(i.item.quality) }}>
                                                        {i.item.name ?? `Item #${i.item.item_id}`}
                                                    </span>
                                                    <div className="item-id">{i.obs_min}+ obs/day · {i.listing_count ?? '—'} listed</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td>
                                            <Gold copper={i.current_price} />
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>{i.realm_name}</div>
                                        </td>
                                        <td><RhythmSpark item={i} todayDow={today} /></td>
                                        <td><DayChip dow={i.buy_dow} kind="buy" /></td>
                                        <td><DayChip dow={i.sell_dow} kind="sell" /></td>
                                        <td>
                                            <span style={{ fontWeight: 700, color: 'var(--accent-gold)' }}>
                                                +{(i.swing_pct * 100).toFixed(0)}%
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div style={{ marginTop: 16, padding: '12px 0', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                        <span>
                            Rhythm = average daily price by weekday over 90 days, normalized to each item&rsquo;s own norm.
                            A tendency, not a promise &mdash; thin markets drift.
                        </span>
                        <span>Only items with every weekday observed {`≥`}6 times and a live market signal qualify.</span>
                    </div>
                </>
            )}
        </div>
    );
}
