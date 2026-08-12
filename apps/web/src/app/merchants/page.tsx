'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MerchantsResponse, fetchMerchants, formatGoldCompact, timeAgo } from '@/lib/api';
import { SiteNav, SortableTh, useTableSort } from '@/components/market-widgets';

export default function MerchantsPage() {
    const router = useRouter();
    const [data, setData] = useState<MerchantsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchMerchants(100)
            .then(setData)
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const { sorted, sortKey, sortDir, toggle } = useTableSort(
        data?.merchants ?? [],
        {
            seller: m => m.seller,
            sold: m => m.sold_ish,
            live: m => m.live_now,
            tracked: m => m.tracked,
            gold: m => m.gold_early,
            items: m => m.distinct_items,
        },
        'server'
    );

    return (
        <div className="page-container">
            <SiteNav />

            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>🏪 Merchants</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0', maxWidth: 780 }}>
                        Follow the smart money &mdash; sellers whose decor listings actually move, from
                        in-game AH scans joined with our auction-lifecycle tracking. &ldquo;Sold-ish&rdquo;
                        means removed before it could expire: a sale or a cancel, never an expiry.
                    </p>
                    <span style={{ display: 'block', minHeight: '1.2em', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {data?.generated_at ? <>Updated {timeAgo(data.generated_at)}</> : ' '}
                    </span>
                </div>
            </div>

            {error && <div className="glass-card" style={{ padding: 20, color: 'var(--accent-red)', fontSize: '0.85rem' }}>{error}</div>}
            {loading && <div className="glass-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Checking the books&hellip;</div>}

            {data?.status === 'no_data' && !loading && (
                <div className="glass-card fade-in" style={{ padding: '28px 32px', color: 'var(--text-secondary)', maxWidth: 780 }}>
                    <div style={{ fontSize: '2rem', marginBottom: 8 }} aria-hidden>🔍</div>
                    <h3 style={{ color: 'var(--accent-gold)', margin: '0 0 8px', fontSize: '1.05rem' }}>
                        No merchants tracked yet — the scanner is ready
                    </h3>
                    <p style={{ fontSize: '0.9rem', margin: '0 0 14px', lineHeight: 1.55 }}>
                        Blizzard&rsquo;s web API never says <em>who</em> listed an auction — but the game
                        client does. One in-game scan attributes every decor listing on your realm to its
                        seller; our lifecycle tracking then scores which sellers&rsquo; listings actually move.
                    </p>
                    <ol style={{ fontSize: '0.84rem', margin: 0, paddingLeft: 20, lineHeight: 1.8, color: 'var(--text-muted)' }}>
                        <li>Update the FlipTheTableCapture addon (v0.3.0 adds <code>/fttscan</code>)</li>
                        <li>Open the Auction House and run <code>/fttscan</code> — takes under a minute</li>
                        <li><code>/reload</code>, then convert the SavedVariables file:
                            {' '}<code>python scripts/convert_ah_scan.py &lt;path&gt;</code></li>
                        <li>Commit the JSON in <code>data/ah_scans/</code> and dispatch the
                            {' '}<strong>AH Scan Import</strong> workflow</li>
                    </ol>
                    <p style={{ fontSize: '0.76rem', margin: '14px 0 0', color: 'var(--text-muted)' }}>
                        Scans are read-only browse queries — the addon never bids, buys, posts, or cancels.
                    </p>
                </div>
            )}

            {data?.status === 'ok' && (
                <div className="data-table-wrapper fade-in">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <SortableTh label="Merchant" k="seller" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                                <SortableTh label="Sold-ish" k="sold" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Tracked listings removed before they could expire" />
                                <SortableTh label="Live now" k="live" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Scanned listings still on the AH" />
                                <SortableTh label="Tracked" k="tracked" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="All listings ever attributed to this seller" />
                                <SortableTh label="Gold moved" k="gold" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Sum of asking prices on sold-ish listings — an upper bound, cancels included" />
                                <SortableTh label="Items" k="items" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Distinct items this seller lists" />
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map(m => (
                                <tr key={`${m.seller}-${m.connected_realm_id}`}
                                    onClick={() => router.push(`/merchants/${encodeURIComponent(m.seller)}?realm=${m.connected_realm_id}`)}
                                    style={{ cursor: 'pointer' }}>
                                    <td>
                                        <div style={{ fontWeight: 600 }}>{m.seller}</div>
                                        <div className="item-id">{m.realm_name ?? `Realm ${m.connected_realm_id}`} · scanned {m.last_scanned ? timeAgo(m.last_scanned) : '—'}</div>
                                    </td>
                                    <td style={{ fontWeight: 700, color: 'var(--accent-emerald)' }}>{m.sold_ish}</td>
                                    <td>{m.live_now}</td>
                                    <td style={{ color: 'var(--text-secondary)' }}>{m.tracked}</td>
                                    <td>{m.gold_early > 0 ? `~${formatGoldCompact(m.gold_early)}g` : '—'}</td>
                                    <td>{m.distinct_items}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {data?.status === 'ok' && (
                <div style={{ marginTop: 16, padding: '12px 0', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
                    Coverage is limited to realms and moments you scanned — run /fttscan regularly to keep
                    attribution fresh. Sold-ish includes cancels; it is an upper bound on sales.
                </div>
            )}
        </div>
    );
}
