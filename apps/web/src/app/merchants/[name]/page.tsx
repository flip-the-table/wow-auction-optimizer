'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MerchantProfileResponse, fetchMerchant, formatGoldCompact, qualityColor, timeAgo } from '@/lib/api';
import { SiteNav, Gold } from '@/components/market-widgets';

const STATUS_CHIP: Record<string, { label: string; cls: string; title: string }> = {
    live: { label: '🟢 Live', cls: 'positive', title: 'Still listed on the AH right now' },
    early: { label: '⚡ Sold-ish', cls: 'positive', title: 'Removed before it could expire — a sale or a cancel, never an expiry' },
    ambiguous: { label: '❓ Removed', cls: 'neutral', title: 'Disappeared, but an expiry cannot be ruled out' },
    unknown: { label: '· Untracked', cls: 'neutral', title: 'No lifecycle data (scan predates tracking or outcome aged out)' },
};

function MerchantProfile({ name }: { name: string }) {
    const sp = useSearchParams();
    const router = useRouter();
    const realmParam = sp?.get('realm');
    const [data, setData] = useState<MerchantProfileResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchMerchant(name, realmParam ? Number(realmParam) : undefined)
            .then(setData)
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, [name, realmParam]);

    return (
        <div className="page-container">
            <SiteNav />

            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>🏪 {decodeURIComponent(name)}</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
                        Merchant ledger &mdash; every listing we attributed to this seller and what became of it.
                    </p>
                    <span style={{ display: 'block', minHeight: '1.2em', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {data?.generated_at ? <>Updated {timeAgo(data.generated_at)}</> : ' '}
                    </span>
                </div>
            </div>

            {error && <div className="glass-card" style={{ padding: 20, color: 'var(--accent-red)', fontSize: '0.85rem' }}>{error}</div>}
            {loading && <div className="glass-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Opening the ledger&hellip;</div>}

            {data?.status === 'no_data' && !loading && (
                <div className="glass-card" style={{ padding: 24, color: 'var(--text-secondary)' }}>
                    No tracked listings for this seller{realmParam ? ' on this realm' : ''} — they may not
                    have been listing decor during your scans.
                </div>
            )}

            {data?.status === 'ok' && (
                <>
                    <div className="pulse-strip fade-in" style={{ marginBottom: 14 }}>
                        <div className="pulse-tile" title="Removed before they could expire — sale or cancel">
                            <span className="pulse-label">⚡ Sold-ish</span>
                            <span className="pulse-value">{data.stats.sold_ish}</span>
                        </div>
                        <div className="pulse-tile" title="Attributed listings currently on the AH">
                            <span className="pulse-label">🟢 Live now</span>
                            <span className="pulse-value">{data.stats.live_now}</span>
                        </div>
                        <div className="pulse-tile" title="Sum of asking prices on sold-ish listings — upper bound">
                            <span className="pulse-label">💰 Gold moved</span>
                            <span className="pulse-value">~{formatGoldCompact(data.stats.gold_early)}g</span>
                        </div>
                        <div className="pulse-tile" title="Distinct items this seller lists — their playbook breadth">
                            <span className="pulse-label">📦 Distinct items</span>
                            <span className="pulse-value">{data.stats.distinct_items}</span>
                        </div>
                    </div>

                    <div className="data-table-wrapper fade-in">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th>Asking</th>
                                    <th>Status</th>
                                    <th>Seen / removed</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.listings.map(l => {
                                    const chip = STATUS_CHIP[l.status] ?? STATUS_CHIP.unknown;
                                    return (
                                        <tr key={l.auction_id}
                                            onClick={() => router.push(`/item/${l.item.item_id}`)}
                                            style={{ cursor: 'pointer' }}>
                                            <td>
                                                <div className="item-cell">
                                                    {l.item.icon_url
                                                        ? <img src={l.item.icon_url} alt="" className="item-icon" loading="lazy" />
                                                        : <div className="item-icon-placeholder">{l.item.item_id}</div>}
                                                    <div>
                                                        <span className="item-name" style={{ color: qualityColor(l.item.quality) }}>
                                                            {l.item.name ?? `Item #${l.item.item_id}`}
                                                        </span>
                                                        <div className="item-id">{l.realm_name}{l.quantity > 1 ? ` · x${l.quantity}` : ''}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td><Gold copper={l.unit_price} /></td>
                                            <td><span className={`stat-badge ${chip.cls}`} title={chip.title}>{chip.label}</span></td>
                                            <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                                {timeAgo(l.scanned_at)}{l.removed_at ? ` → ${timeAgo(l.removed_at)}` : ''}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div style={{ marginTop: 16, padding: '12px 0', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
                        Attribution exists only for scanned moments. Sold-ish includes cancels — treat it
                        as an upper bound on realized sales.
                    </div>
                </>
            )}
        </div>
    );
}

export default function MerchantPage({ params }: { params: { name: string } }) {
    return (
        <Suspense fallback={<div className="page-container"><SiteNav /></div>}>
            <MerchantProfile name={params.name} />
        </Suspense>
    );
}
