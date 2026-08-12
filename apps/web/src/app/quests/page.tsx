'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { QuestsResponse, fetchQuests, qualityColor, timeAgo, nextRefreshLabel } from '@/lib/api';
import { SiteNav } from '@/components/market-widgets';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TAG_STYLE: Record<string, { color: string; bg: string }> = {
    BUY: { color: '#6ea8fe', bg: 'rgba(59, 130, 246, 0.12)' },
    SELL: { color: '#d99a2b', bg: 'rgba(192, 125, 10, 0.14)' },
    CRAFT: { color: 'var(--accent-emerald)', bg: 'rgba(16, 185, 129, 0.12)' },
    SCOUT: { color: 'var(--accent-purple)', bg: 'rgba(124, 58, 237, 0.14)' },
};

export default function QuestsPage() {
    const [data, setData] = useState<QuestsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<Set<string>>(new Set());
    const [storageKey, setStorageKey] = useState<string | null>(null);

    useEffect(() => {
        fetchQuests()
            .then((d) => {
                setData(d);
                const key = `ftt-dailies-${d.date}`;
                setStorageKey(key);
                try {
                    const saved = JSON.parse(localStorage.getItem(key) ?? '[]');
                    if (Array.isArray(saved)) setDone(new Set(saved));
                } catch { }
            })
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    const toggle = (id: string) => {
        setDone(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            if (storageKey) {
                try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { }
            }
            return next;
        });
    };

    const tasks = data?.tasks ?? [];
    const doneCount = useMemo(() => tasks.filter(t => done.has(t.id)).length, [tasks, done]);
    const allDone = tasks.length > 0 && doneCount === tasks.length;
    const pct = tasks.length ? (doneCount / tasks.length) * 100 : 0;

    return (
        <div className="page-container">
            <SiteNav />

            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>✅ Dailies</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0', maxWidth: 760 }}>
                        Today&rsquo;s gold-making plan, composed from every signal in the ledger &mdash;
                        rhythms, opportunities, margins, merchants. Check them off. Reset at daily rollover.
                    </p>
                    <span style={{ display: 'block', minHeight: '1.2em', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {data
                            ? <>{DAYS[data.today_dow]} (UTC) &middot; Updated {timeAgo(data.generated_at)} &middot; Fresh tasks ~{nextRefreshLabel()}</>
                            : ' '}
                    </span>
                </div>
            </div>

            {error && <div className="glass-card" style={{ padding: 20, color: 'var(--accent-red)', fontSize: '0.85rem' }}>{error}</div>}
            {loading && <div className="glass-card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Consulting the ledger&hellip;</div>}

            {data?.status === 'no_data' && !loading && (
                <div className="glass-card" style={{ padding: '24px 28px', color: 'var(--text-secondary)', maxWidth: 720 }}>
                    <h3 style={{ color: 'var(--accent-gold)', margin: '0 0 8px' }}>No quests on the board</h3>
                    <p style={{ fontSize: '0.88rem', margin: 0 }}>
                        Task sources need fresh signals &mdash; check back after the next data refresh
                        (~{nextRefreshLabel()}).
                    </p>
                </div>
            )}

            {tasks.length > 0 && (
                <>
                    {/* Progress */}
                    <div className="quest-progress-wrap fade-in">
                        <div className="quest-progress-track">
                            <div className="quest-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="quest-progress-label">
                            {allDone ? '✨ All dailies complete!' : `${doneCount} / ${tasks.length} complete`}
                        </span>
                    </div>

                    {allDone && (
                        <div className="quest-complete-banner fade-in" role="status">
                            <span style={{ fontSize: '1.6rem' }} aria-hidden>🏆</span>
                            <div>
                                <div style={{ fontFamily: 'var(--font-serif)', fontWeight: 700, fontSize: '1.05rem', color: 'var(--accent-gold)' }}>
                                    Ledger closed for the day
                                </div>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                    Every signal acted on. New quests arrive with the next daily rollover.
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="quest-list">
                        {tasks.map(t => {
                            const isDone = done.has(t.id);
                            const tag = TAG_STYLE[t.tag] ?? TAG_STYLE.SCOUT;
                            return (
                                <div key={t.id} className={'quest-card fade-in' + (isDone ? ' done' : '')}>
                                    <button
                                        className="quest-check"
                                        aria-pressed={isDone}
                                        aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
                                        onClick={() => toggle(t.id)}
                                    >
                                        {isDone ? '✓' : ''}
                                    </button>
                                    {t.item?.icon_url
                                        ? <img src={t.item.icon_url} alt="" className="item-icon" loading="lazy" />
                                        : <span className="quest-icon" aria-hidden>{t.icon}</span>}
                                    <div className="quest-body">
                                        <div className="quest-title-row">
                                            <span className="quest-tag" style={{ color: tag.color, background: tag.bg }}>{t.tag}</span>
                                            <a
                                                className="quest-title"
                                                href={t.href}
                                                style={t.item ? { color: qualityColor(t.item.quality) } : undefined}
                                            >
                                                {t.title}
                                            </a>
                                        </div>
                                        <div className="quest-detail">{t.detail}</div>
                                    </div>
                                    <a className="quest-go" href={t.href} aria-label="Open details">→</a>
                                </div>
                            );
                        })}
                    </div>

                    <div style={{ marginTop: 16, padding: '12px 0', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
                        Tasks are recommendations from listing-derived signals, not guarantees. Check-offs
                        live in this browser only and reset at UTC midnight.
                    </div>
                </>
            )}
        </div>
    );
}
