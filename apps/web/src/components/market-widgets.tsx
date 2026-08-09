'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { TokenResponse, fetchToken, formatGold, formatGoldCompact, timeAgo } from '@/lib/api';

// --- WoW Token chip: converts everything on the page into "sub money" ------
export function TokenChip() {
    const [token, setToken] = useState<TokenResponse | null>(null);
    useEffect(() => {
        fetchToken().then(setToken).catch(() => { });
    }, []);
    // Reserve the chip's space while the price loads — the pop-in was the
    // largest layout shift on every page (CLS 0.08 on wide tables).
    if (!token) {
        return (
            <span className="token-chip" style={{ visibility: 'hidden' }} aria-hidden>
                <span className="token-coin">🪙</span>
                <span>US Token 000,000g</span>
                <span style={{ fontSize: '0.72rem' }}> ▲0.0% 7d</span>
                <span className="token-updated">· 00m ago</span>
            </span>
        );
    }
    if (token.status !== 'ok' || !token.gold) return null;
    const delta = token.change_7d_pct;
    const deltaText = delta != null
        ? ` ${delta >= 0 ? '▲' : '▼'}${Math.abs(delta * 100).toFixed(1)}% 7d`
        : '';
    // Prefer Blizzard's own price timestamp; fall back to our ingest time
    const updatedIso = token.blizzard_updated_at ?? token.updated_at;
    const updatedText = updatedIso ? timeAgo(updatedIso) : null;
    const regionLabel = token.region ? token.region.toUpperCase() : null;
    return (
        <span
            className="token-chip"
            title={`1 WoW Token = 30 days of game time. Earn ${token.gold.toLocaleString()}g a month and the subscription pays for itself.${delta != null ? ` Price ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta * 100).toFixed(1)}% over 7 days.` : ''}${updatedIso ? ` Price as of ${new Date(updatedIso).toLocaleString()}.` : ''} Source: Blizzard's official game data API — the token price is set region-wide${regionLabel ? ` (identical on every ${regionLabel} realm)` : ''}, not per realm.`}
        >
            <span className="token-coin" aria-hidden>🪙</span>
            <span>{regionLabel ? `${regionLabel} ` : ''}Token {token.gold.toLocaleString()}g</span>
            {deltaText && (
                <span style={{
                    color: delta != null && delta < 0 ? 'var(--accent-emerald)' : 'var(--text-muted)',
                    fontSize: '0.72rem',
                }}>
                    {deltaText}
                </span>
            )}
            {updatedText && (
                <span className="token-updated">· {updatedText}</span>
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


// --- Unified site navigation: one consistent home for every surface --------
const NAV_TABS = [
    { href: '/', label: 'Radar', icon: '📡' },
    { href: '/watch', label: 'Opportunities', icon: '🎯' },
    { href: '/timing', label: 'Almanac', icon: '📅' },
    { href: '/craft', label: 'Craft', icon: '⚒' },
    { href: '/lumber', label: 'Lumber', icon: '🪵' },
];

export function SiteNav() {
    const pathname = usePathname() ?? '/';
    return (
        <nav className="site-nav" aria-label="Primary">
            <a href="/" className="nav-brand" title="Flip the Table — WoW decor market intelligence">
                <span aria-hidden>🪑</span>
                <span className="nav-brand-text">Flip the Table</span>
            </a>
            {NAV_TABS.map(t => {
                const active = t.href === '/' ? pathname === '/' : pathname.startsWith(t.href);
                return (
                    <a key={t.href} href={t.href}
                        className={'site-tab' + (active ? ' active' : '')}
                        aria-current={active ? 'page' : undefined}>
                        <span className="tab-icon" aria-hidden>{t.icon}</span>
                        {t.label}
                    </a>
                );
            })}
            <span style={{ marginLeft: 'auto' }}><TokenChip /></span>
        </nav>
    );
}


// --- Client-side table sorting ----------------------------------------------
// Rows are already loaded; sorting rearranges them without another fetch.
// Accessors return number|string|null; nulls always sink to the bottom.
export function useTableSort<T>(
    rows: T[],
    accessors: Record<string, (r: T) => number | string | null | undefined>,
    defaultKey: string,
    defaultDir: 'asc' | 'desc' = 'desc',
) {
    const [sortKey, setSortKey] = useState(defaultKey);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultDir);

    const sorted = useMemo(() => {
        const acc = accessors[sortKey];
        if (!acc) return rows;
        const mul = sortDir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => {
            const av = acc(a);
            const bv = acc(b);
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'string' || typeof bv === 'string') {
                return String(av).localeCompare(String(bv)) * mul;
            }
            return (av - (bv as number)) * mul;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, sortKey, sortDir]);

    const toggle = (key: string) => {
        if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        else {
            setSortKey(key);
            setSortDir('desc');
        }
    };

    return { sorted, sortKey, sortDir, toggle };
}

export function SortableTh({
    label, k, sortKey, sortDir, onToggle, title,
}: {
    label: React.ReactNode;
    k: string;
    sortKey: string;
    sortDir: 'asc' | 'desc';
    onToggle: (k: string) => void;
    title?: string;
}) {
    const active = sortKey === k;
    return (
        <th
            onClick={() => onToggle(k)}
            className={active ? 'sorted' : undefined}
            title={title ?? 'Click to sort'}
            style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
        >
            {label}
            <span style={{ marginLeft: 4, fontSize: '0.65rem', opacity: active ? 1 : 0.35 }} aria-hidden>
                {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
            </span>
        </th>
    );
}

// --- Shared gold display -----------------------------------------------------
// >= 1,000g: compact number + single gold coin (keeps table columns narrow;
// full value in the tooltip). Below that: classic gold/silver/copper coins.
export function Gold({ copper }: { copper: number | null | undefined }) {
    if (copper == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
    const negative = copper < 0;
    const abs = Math.abs(copper);
    const g = abs / 10000;
    const style = negative ? { color: 'var(--accent-red)' } : undefined;
    if (g >= 1000) {
        return (
            <span className="gold-amount" style={style}
                title={`${negative ? '-' : ''}${Math.floor(g).toLocaleString()}g exactly`}>
                {negative && <span>-</span>}
                <span>{formatGoldCompact(abs)}</span>
                <span className="coin coin-gold" />
            </span>
        );
    }
    const { gold, silver, copper: cop } = formatGold(abs);
    return (
        <span className="gold-amount" style={style}>
            {negative && <span>-</span>}
            {gold > 0 && (<><span>{gold.toLocaleString()}</span><span className="coin coin-gold" /></>)}
            {(gold > 0 || silver > 0) && (<><span>{silver}</span><span className="coin coin-silver" /></>)}
            <span>{cop}</span><span className="coin coin-copper" />
        </span>
    );
}
