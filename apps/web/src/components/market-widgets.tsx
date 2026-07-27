'use client';

import React, { useEffect, useState } from 'react';
import { TokenResponse, fetchToken } from '@/lib/api';

// --- WoW Token chip: converts everything on the page into "sub money" ------
export function TokenChip() {
    const [token, setToken] = useState<TokenResponse | null>(null);
    useEffect(() => {
        fetchToken().then(setToken).catch(() => { });
    }, []);
    if (!token || token.status !== 'ok' || !token.gold) return null;
    const delta = token.change_7d_pct;
    const deltaText = delta != null
        ? ` ${delta >= 0 ? '▲' : '▼'}${Math.abs(delta * 100).toFixed(1)}% 7d`
        : '';
    return (
        <span
            className="token-chip"
            title={`1 WoW Token = 30 days of game time. Earn ${token.gold.toLocaleString()}g a month and the subscription pays for itself.${delta != null ? ` Price ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta * 100).toFixed(1)}% over 7 days.` : ''}`}
        >
            <span className="token-coin" aria-hidden>🪙</span>
            <span>Token {token.gold.toLocaleString()}g</span>
            {deltaText && (
                <span style={{
                    color: delta != null && delta < 0 ? 'var(--accent-emerald)' : 'var(--text-muted)',
                    fontSize: '0.68rem',
                }}>
                    {deltaText}
                </span>
            )}
        </span>
    );
}

// --- Listing-age mix: 4-segment freshness bar (VERY_LONG = freshly listed) --
export function AgeMixBar({ age }: {
    age: { short: number; medium: number; long: number; very_long: number } | null | undefined;
}) {
    if (!age) return null;
    const total = age.short + age.medium + age.long + age.very_long;
    if (total === 0) return null;
    const seg = (n: number, color: string, label: string) =>
        n > 0 ? <span key={label} style={{ width: `${(n / total) * 100}%`, background: color }} /> : null;
    const freshPct = Math.round((age.very_long / total) * 100);
    return (
        <div
            className="age-mix"
            title={`Listing age mix: ${age.very_long} fresh (listed <36h ago) · ${age.long} aging · ${age.medium} old · ${age.short} about to expire. ${freshPct}% fresh — a low fresh share can mean a stale price wall rather than an active market.`}
        >
            <div className="age-mix-bar">
                {seg(age.very_long, 'var(--accent-emerald)', 'fresh')}
                {seg(age.long, 'var(--accent-gold)', 'aging')}
                {seg(age.medium, 'var(--accent-orange)', 'old')}
                {seg(age.short, 'var(--accent-red)', 'expiring')}
            </div>
            <span className="age-mix-label">{freshPct}% fresh</span>
        </div>
    );
}
