'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    DecorConversionRow,
    DecorOpportunitiesResponse,
    MaterialInfo,
    MaterialValueResponse,
    RealmSlugEntry,
    fetchDecorOpportunities,
    fetchMaterialValue,
    fetchRealmList,
    qualityColor,
    timeAgo,
} from '@/lib/api';
import { SiteNav, Gold } from '@/components/market-widgets';

const CHARACTER_STORAGE_KEY = 'ftt-character';

// NOTE (Phase 15): user overrides are intentionally NOT implemented yet. This
// is the extension point — a future provider returns USER_PROVIDED values from
// localStorage; the public model always uses the documented configuration.
// interface AssumptionOverrides { realized_price_factor?: number; ... }
// function getOverrides(): AssumptionOverrides { return {}; }


// Verdict chips per Phase 14.2 — never "Craft now" (recipe access is unknown)
function ConversionVerdict({ row }: { row: DecorConversionRow }) {
    let label: string, cls: string, title: string;
    if (row.eligibility_status === 'EXCLUDED') {
        const stale = row.exclusion_reasons.some(r => r.includes('STALE'));
        label = stale ? '⏳ Stale' : '🚫 Missing inputs';
        cls = 'neutral';
        title = `Excluded: ${row.exclusion_reasons.join(', ')}`;
    } else if ((row.implied_value_per_material ?? 0) <= 0) {
        label = '🔻 Unprofitable'; cls = 'negative';
        title = 'Modeled conversion value is at or below zero on this realm.';
    } else if ((row.model_quality ?? 0) < 0.35) {
        label = '❔ Low-quality estimate'; cls = 'neutral';
        title = 'Inputs are thin, aging, or uncertain — treat with caution.';
    } else if ((row.liquidity_score ?? 0) < 0.3) {
        label = '💤 Thin market'; cls = 'neutral';
        title = 'Few listings / little stock movement backing this estimate.';
    } else if ((row.model_quality ?? 0) >= 0.6) {
        label = '✅ Strong conversion'; cls = 'positive';
        title = 'Positive modeled value with comparatively solid inputs.';
    } else {
        label = '👍 Good conversion'; cls = 'positive';
        title = 'Positive modeled value with acceptable input quality.';
    }
    return <span className={`stat-badge ${cls}`} title={title} style={{ whiteSpace: 'nowrap' }}>{label}</span>;
}

function ScoreBadge({ value, label }: { value: number | null | undefined; label: string }) {
    if (value == null) return <span className="stat-badge neutral">—</span>;
    const pct = Math.round(value * 100);
    const cls = value >= 0.6 ? 'positive' : value >= 0.35 ? 'neutral' : 'negative';
    return (
        <span
            className={`stat-badge ${cls}`}
            title={`${label}: heuristic assessment of source verification, freshness, liquidity, and input completeness. It is not a probability.`}
        >
            {pct}%
        </span>
    );
}

// Calculation drawer (Phase 14.3): full inspectable arithmetic per row
function CalculationDrawer({ row }: { row: DecorConversionRow }) {
    const snap = row.input_snapshot ?? {};
    const g = (c: number | null | undefined) =>
        c == null ? '—' : `${(c / 10000).toLocaleString(undefined, { maximumFractionDigits: 2 })}g (${c.toLocaleString()}c)`;
    const line = (label: string, value: React.ReactNode, cls?: string) => (
        <tr>
            <td style={{ padding: '2px 16px 2px 0', color: 'var(--text-secondary)' }}>{label}</td>
            <td style={{ padding: '2px 12px 2px 0', fontVariantNumeric: 'tabular-nums' }}>{value}</td>
            <td style={{ padding: '2px 0', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{cls}</td>
        </tr>
    );
    return (
        <div style={{ fontSize: '0.78rem' }}>
            <table style={{ borderCollapse: 'collapse' }}>
                <tbody>
                    {line('Observed listing median', g(row.listing_median), 'OBSERVED_LISTING')}
                    {line(`× realized-price factor (${snap?.params?.realized_price_factor ?? '—'})`,
                        g(row.estimated_realized_unit_price), 'MODELED')}
                    {line(`× crafted quantity (${row.crafted_quantity ?? '—'})`, g(row.gross_estimated_revenue), 'MODELED')}
                    {line(`− AH cut (${((snap?.params?.ah_cut ?? 0) * 100).toFixed(0)}%) − deposit loss (${g(row.expected_deposit_loss)})`,
                        g(row.net_estimated_revenue), 'MODELED')}
                    {line('− other reagent costs', g(row.other_reagent_cost), 'OBSERVED_LISTING / VENDOR')}
                    {line(`÷ material quantity (${row.material_quantity ?? '—'})`, <strong><Gold copper={row.implied_value_per_material} /></strong>, 'MODELED')}
                </tbody>
            </table>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                <span>Recipe source: {row.recipe.source_version ?? '—'} ({row.recipe.verification_status}) · CURATED_SOURCE</span>
                <span>Listing snapshot: {row.listing_updated_at ? timeAgo(row.listing_updated_at) : '—'} · {row.listing_count ?? '—'} listings, {row.listed_quantity ?? '—'} listed</span>
                <span>Churn-based market activity: ~{(row.estimated_market_units_per_day ?? 0).toFixed(1)}/day · DERIVED</span>
                <span>× capture factor {row.seller_capture_factor ?? '—'} → ~{(row.estimated_capturable_units_per_day ?? 0).toFixed(1)} capturable/day · MODELED</span>
                <span>Scores — freshness {row.freshness_score ?? '—'} · liquidity {row.liquidity_score ?? '—'} · input quality {row.input_quality_score ?? '—'}</span>
                {(snap?.warnings ?? []).length > 0 && (
                    <span style={{ color: 'var(--accent-gold)' }}>Warnings: {(snap.warnings as string[]).join(', ')}</span>
                )}
                {row.exclusion_reasons.length > 0 && (
                    <span style={{ color: 'var(--accent-red)' }}>Exclusions: {row.exclusion_reasons.join(', ')}</span>
                )}
            </div>
            {(snap?.reagents ?? []).length > 0 && (
                <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    Reagent inputs:{' '}
                    {(snap.reagents as any[]).map((r, i) => (
                        <span key={i} style={{ marginRight: 10 }}>
                            item {r.item_id} ×{r.quantity} @ {r.unit_price != null ? `${(r.unit_price / 10000).toFixed(2)}g` : 'no price'} ({r.pricing_scope})
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function LumberPage() {
    const [materials, setMaterials] = useState<MaterialInfo[]>([]);
    const [materialKey, setMaterialKey] = useState<string>('');
    const [realmList, setRealmList] = useState<RealmSlugEntry[]>([]);
    const [realmId, setRealmId] = useState<number | undefined>();
    const [summary, setSummary] = useState<MaterialValueResponse | null>(null);
    const [opps, setOpps] = useState<DecorOpportunitiesResponse | null>(null);
    const [sort, setSort] = useState('value_per_material');
    const [includeExcluded, setIncludeExcluded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const [showAssumptions, setShowAssumptions] = useState(false);
    const [bootStatus, setBootStatus] = useState<'loading' | 'ready' | 'disabled' | 'no_mapping'>('loading');

    // Bootstrap: materials + realms (+ default realm from saved character)
    useEffect(() => {
        (async () => {
            try {
                const [mats, realms] = await Promise.all([
                    fetchMaterialValue({}),
                    fetchRealmList().catch(() => [] as RealmSlugEntry[]),
                ]);
                setRealmList(realms);
                if (mats.status === 'disabled') { setBootStatus('disabled'); return; }
                if (mats.status === 'no_mapping' || !(mats.materials ?? []).length) {
                    setBootStatus('no_mapping'); return;
                }
                setMaterials(mats.materials!);
                setMaterialKey(mats.materials![0].material_key);
                // Personalized default realm (Phase 10.1)
                try {
                    const saved = JSON.parse(localStorage.getItem(CHARACTER_STORAGE_KEY) ?? 'null');
                    const entry = saved?.realmSlug ? realms.find(r => r.slug === saved.realmSlug) : undefined;
                    setRealmId(entry?.connected_realm_id ?? realms[0]?.connected_realm_id);
                } catch {
                    setRealmId(realms[0]?.connected_realm_id);
                }
                setBootStatus('ready');
            } catch (e: any) {
                setError(e.message || 'Failed to initialize');
                setBootStatus('ready');
            }
        })();
    }, []);

    const loadData = useCallback(async () => {
        if (!materialKey || !realmId) return;
        try {
            setLoading(true);
            setError(null);
            const [s, o] = await Promise.all([
                fetchMaterialValue({ material: materialKey, realm: realmId }),
                fetchDecorOpportunities({
                    material: materialKey, realm: realmId, sort,
                    limit: 50, includeExcluded,
                }),
            ]);
            setSummary(s);
            setOpps(o);
        } catch (e: any) {
            setError(e.message || 'Failed to load data');
        } finally {
            setLoading(false);
        }
    }, [materialKey, realmId, sort, includeExcluded]);

    useEffect(() => { loadData(); }, [loadData]);

    const realmName = useMemo(
        () => summary?.realm?.name ?? realmList.find(r => r.connected_realm_id === realmId)?.name ?? null,
        [summary, realmList, realmId]
    );

    const toggleExpand = (id: number) => setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const a = summary?.assumptions;

    return (
        <div className="page-container">
            <SiteNav />
            {/* Header */}
            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>Implied Lumber Value</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0', maxWidth: 720 }}>
                        This is a <strong>modeled opportunity value</strong> inferred from decor listings and
                        recipe costs. Lumber is not directly priced on the Auction House.
                    </p>
                </div>
            </div>

            {/* Global empty states */}
            {bootStatus === 'loading' && (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
            )}
            {bootStatus === 'disabled' && (
                <div className="glass-card" style={{ padding: 24, color: 'var(--text-secondary)' }}>
                    The implied lumber valuation feature is currently disabled.
                </div>
            )}
            {bootStatus === 'no_mapping' && (
                <div className="glass-card" style={{ padding: 24, color: 'var(--text-secondary)', maxWidth: 720 }}>
                    <h3 style={{ color: 'var(--accent-gold)', marginBottom: 8 }}>No decor recipe mapping loaded</h3>
                    <p style={{ fontSize: '0.9rem' }}>
                        Blizzard&rsquo;s professions API exposes no decor-crafting recipes, so this feature
                        relies on a manually verified, versioned recipe mapping — and none has been imported
                        yet. Once a verified source file is loaded (see <code>data/decor_recipes/README.md</code>),
                        implied values will appear here automatically after the next data refresh.
                        No values are shown because none can honestly be computed.
                    </p>
                </div>
            )}

            {bootStatus === 'ready' && (
                <>
                    {/* Controls */}
                    <div className="filter-bar">
                        <select className="filter-select" value={materialKey} onChange={(e) => setMaterialKey(e.target.value)}>
                            {materials.map(m => (
                                <option key={m.material_key} value={m.material_key}>{m.display_name}</option>
                            ))}
                        </select>
                        <select className="filter-select" value={realmId ?? ''} onChange={(e) => setRealmId(e.target.value ? Number(e.target.value) : undefined)}>
                            <option value="">Select realm…</option>
                            {realmList.map(r => (
                                <option key={r.slug} value={r.connected_realm_id}>{r.name}</option>
                            ))}
                        </select>
                        <select className="filter-select" value={sort} onChange={(e) => setSort(e.target.value)}>
                            <option value="value_per_material">Sort: Value per lumber</option>
                            <option value="expected_daily_contribution">Sort: Expected daily opportunity</option>
                            <option value="model_quality">Sort: Model quality</option>
                            <option value="listing_liquidity">Sort: Listing liquidity</option>
                        </select>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                            <input type="checkbox" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} />
                            Show excluded recipes
                        </label>
                        <button className="btn btn-ghost" onClick={loadData}>↻ Refresh</button>
                    </div>

                    {error && (
                        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: 16, color: 'var(--accent-red)', fontSize: '0.85rem' }}>
                            {error}
                        </div>
                    )}

                    {/* Summary card (Phase 14.1) */}
                    {summary && (
                        <div className="glass-card fade-in" style={{ padding: 20, marginBottom: 16 }}>
                            {summary.status === 'no_data' && (
                                <div style={{ color: 'var(--text-secondary)' }}>
                                    No eligible decor conversions for <strong>{summary.material?.display_name}</strong> on
                                    {' '}<strong>{realmName ?? 'this realm'}</strong> right now — no value can honestly be
                                    shown. {summary.excluded_recipe_count ? `${summary.excluded_recipe_count} recipes were excluded (see table with "Show excluded").` : ''}
                                </div>
                            )}
                            {summary.status === 'stale' && (
                                <div style={{ color: 'var(--accent-gold)', marginBottom: 10 }}>
                                    ⏳ Inputs are older than the model&rsquo;s freshness limit — values below are the last
                                    computed estimates and should not be treated as current.
                                </div>
                            )}
                            {(summary.status === 'ok' || summary.status === 'insufficient_data' || summary.status === 'stale') && (
                                <>
                                    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'baseline' }}>
                                        <div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                                Reference estimate (weighted median) · MODELED
                                            </div>
                                            <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent-gold)' }}>
                                                {summary.reference_implied_value != null
                                                    ? <><Gold copper={summary.reference_implied_value} /> <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>per {summary.material?.display_name}</span></>
                                                    : <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>unavailable — fewer than {a?.min_eligible_recipes ?? '—'} eligible recipes</span>}
                                            </div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Best current conversion</div>
                                            <div style={{ fontWeight: 700 }}><Gold copper={summary.best_conversion_value} /></div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Conservative (25th pct)</div>
                                            <div style={{ fontWeight: 700 }}><Gold copper={summary.conservative_implied_value} /></div>
                                        </div>
                                        <div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Model quality</div>
                                            <ScoreBadge value={summary.model_quality} label="Model quality" />
                                        </div>
                                    </div>
                                    <div style={{ marginTop: 10, fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                                        <span>Realm: <strong style={{ color: 'var(--text-secondary)' }}>{realmName ?? realmId}</strong> (realm-scoped)</span>
                                        <span>{summary.eligible_recipe_count} eligible · {summary.excluded_recipe_count} excluded recipes</span>
                                        <span>Computed {summary.computed_at ? timeAgo(summary.computed_at) : '—'}</span>
                                        <span>Next refresh ~{summary.next_scheduled_refresh ? new Date(summary.next_scheduled_refresh).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'}</span>
                                        <span>Formula {summary.formula_version} · Source {summary.source_version ?? '—'}</span>
                                        <button onClick={() => setShowAssumptions(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--accent-gold)', cursor: 'pointer', fontSize: '0.75rem', padding: 0 }}>
                                            {showAssumptions ? '▾ Hide assumptions' : '▸ Model assumptions'}
                                        </button>
                                    </div>
                                </>
                            )}

                            {/* Assumptions panel (Phase 14.4) */}
                            {showAssumptions && a && (
                                <div style={{ marginTop: 12, padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                    <ul style={{ listStyle: 'disc', paddingLeft: 18, display: 'grid', gap: 4 }}>
                                        <li>Listing prices are <strong>not confirmed sale prices</strong>; a realized-price factor of <strong>{a.realized_price_factor}</strong> is applied as a modeled haircut.</li>
                                        <li>Demand is inferred from stock churn between snapshots; churn can include <strong>expired and cancelled auctions</strong>, and restocking can hide genuine sales.</li>
                                        <li>Seller capture factor: <strong>{a.seller_capture_factor}</strong> of estimated daily market activity (a model assumption, not a measured probability).</li>
                                        <li>Auction house cut: <strong>{(a.ah_cut * 100).toFixed(0)}%</strong>. Deposit losses: <strong>{a.deposit_loss_rate === 0 ? 'not modeled in this formula version' : `${(a.deposit_loss_rate * 100).toFixed(1)}% of gross`}</strong>.</li>
                                        <li>Inputs older than <strong>{a.max_input_age_hours}h</strong> are excluded; markets need ≥<strong>{a.min_listing_count}</strong> listings and ≥<strong>{a.min_listed_quantity}</strong> listed units; realm prices above <strong>{a.max_cross_realm_multiplier}×</strong> the cross-realm median are excluded.</li>
                                        <li>Reference value: <strong>{a.reference_aggregation}</strong> over eligible recipes (min {a.min_eligible_recipes}); conservative value = weighted <strong>{(a.conservative_percentile * 100).toFixed(0)}th percentile</strong>.</li>
                                        <li>Recipe mappings are a <strong>manually verified curated source</strong> (version {summary.source_version ?? '—'}) — Blizzard&rsquo;s professions API provides no decor recipes.</li>
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Opportunity table (Phase 14.2) */}
                    {opps && opps.rows.length > 0 && (
                        <div className="data-table-wrapper fade-in" style={{ opacity: loading ? 0.6 : 1 }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th title="Crafted decor output (curated recipe mapping)">Decor item</th>
                                        <th title="Curated recipe source version and verification">Recipe source</th>
                                        <th title="Observed realm listing median (not a confirmed sale price)">Listing median</th>
                                        <th title="Listing median x realized-price factor (modeled)">Est. realized</th>
                                        <th title="Cost of priced non-lumber reagents">Other cost</th>
                                        <th title="Constrained material required per craft">Lumber req.</th>
                                        <th title="Modeled value per unit of constrained material">Value / lumber</th>
                                        <th title="Churn-based liquidity estimate — includes expirations/cancellations">Market activity</th>
                                        <th title="Value x capturable units/day (modeled opportunity, not guaranteed gold)">Daily opp.</th>
                                        <th title="Heuristic input-quality score — not a probability">Model quality</th>
                                        <th title="Age of the underlying listing snapshot">Freshness</th>
                                        <th>Verdict</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {opps.rows.map((row) => {
                                        const isOpen = expanded.has(row.recipe.id);
                                        return (
                                            <React.Fragment key={`${row.recipe.id}-${row.connected_realm_id}`}>
                                                <tr onClick={() => toggleExpand(row.recipe.id)} style={{ cursor: 'pointer' }}>
                                                    <td>
                                                        <div className="item-cell">
                                                            {row.decor_item.icon_url
                                                                ? <img src={row.decor_item.icon_url} alt="" className="item-icon" loading="lazy" />
                                                                : <div className="item-icon-placeholder">{row.decor_item.item_id}</div>}
                                                            <div>
                                                                <span className="item-name" style={{ color: qualityColor(row.decor_item.quality) }}>
                                                                    {row.decor_item.name ?? `Item #${row.decor_item.item_id}`}
                                                                </span>
                                                                <div className="item-id">{row.recipe.name ?? row.recipe.external_key}</div>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                        {row.recipe.source_version ?? '—'}
                                                        <div className="item-id">{row.recipe.verification_status}</div>
                                                    </td>
                                                    <td><Gold copper={row.listing_median} />
                                                        <div className="item-id">{row.listing_count ?? '—'} listings</div>
                                                    </td>
                                                    <td><Gold copper={row.estimated_realized_unit_price} /></td>
                                                    <td><Gold copper={row.other_reagent_cost} /></td>
                                                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{row.material_quantity ?? '—'}</td>
                                                    <td style={{ fontWeight: 700 }}><Gold copper={row.implied_value_per_material} /></td>
                                                    <td style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}
                                                        title="Churn-based estimate; cannot distinguish sales from expired or cancelled auctions">
                                                        ~{(row.estimated_market_units_per_day ?? 0).toFixed(1)}/day
                                                    </td>
                                                    <td><Gold copper={row.expected_daily_contribution} /></td>
                                                    <td><ScoreBadge value={row.model_quality} label="Model quality" /></td>
                                                    <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                        {row.listing_updated_at ? timeAgo(row.listing_updated_at) : '—'}
                                                    </td>
                                                    <td><ConversionVerdict row={row} /></td>
                                                </tr>
                                                {isOpen && (
                                                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                                                        <td colSpan={12} style={{ padding: '10px 16px 14px' }}>
                                                            <CalculationDrawer row={row} />
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {opps && opps.rows.length === 0 && summary?.status !== 'no_data' && !loading && (
                        <div className="glass-card" style={{ padding: 24, color: 'var(--text-muted)' }}>
                            No conversions to display for this material/realm{includeExcluded ? '' : ' — try "Show excluded recipes" to see why recipes were filtered out'}.
                        </div>
                    )}

                    {/* Footer */}
                    <div style={{ marginTop: 16, padding: '12px 0', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
                        Implied values are modeled from observed decor listings (not confirmed sales), churn-based
                        liquidity estimates, and a manually verified recipe mapping. Click any row for the full
                        calculation and data classifications.
                    </div>
                </>
            )}
        </div>
    );
}
