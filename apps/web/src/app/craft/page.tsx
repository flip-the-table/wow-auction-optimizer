'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
    CharacterProfessions,
    CraftRecipe,
    CraftResponse,
    RealmSlugEntry,
    fetchCharacter,
    fetchCraftable,
    fetchRealmList,
    formatGold,
    qualityColor,
    timeAgo,
} from '@/lib/api';

const CHARACTER_STORAGE_KEY = 'ftt-character';

// --- Gold Amount Component ---
function GoldAmount({ copper }: { copper: number | null }) {
    if (copper == null) return <span style={{ color: 'var(--text-muted)' }}>--</span>;
    const negative = copper < 0;
    const { gold, silver, copper: cop } = formatGold(Math.abs(copper));
    return (
        <span className="gold-amount" style={negative ? { color: 'var(--accent-red)' } : undefined}>
            {negative && <span>-</span>}
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

// --- Recipe Margin Table ---
function RecipeTable({
    recipes,
    expanded,
    onToggleExpand,
    emptyMessage,
}: {
    recipes: CraftRecipe[];
    expanded: Set<number>;
    onToggleExpand: (recipeId: number) => void;
    emptyMessage: string;
}) {
    const router = useRouter();
    return (
        <div className="data-table-wrapper fade-in">
            <table className="data-table">
                <thead>
                    <tr>
                        <th title="The crafted item">Item</th>
                        <th title="Recipe, profession and expansion tier">Recipe</th>
                        <th title="Sum of reagent costs (region commodity prices, vendor prices, or cheapest realm AH)">Craft Cost</th>
                        <th title="Median buyout on the realm where this item sells highest">Sell (Best Realm)</th>
                        <th title="Sell price x quantity x 0.95 (AH cut) - craft cost">Margin</th>
                        <th title="Margin as % of craft cost">Margin %</th>
                    </tr>
                </thead>
                <tbody>
                    {recipes.map((r: CraftRecipe) => {
                        const isExpanded = expanded.has(r.recipe_id);
                        return (
                            <React.Fragment key={r.recipe_id}>
                                <tr
                                    onClick={() => r.item.item_id && router.push(`/item/${r.item.item_id}`)}
                                    style={{ cursor: r.item.item_id ? 'pointer' : 'default' }}
                                >
                                    <td>
                                        <div className="item-cell">
                                            {r.item.icon_url ? (
                                                <img src={r.item.icon_url} alt="" className="item-icon" loading="lazy" />
                                            ) : (
                                                <div className="item-icon-placeholder">{r.item.item_id}</div>
                                            )}
                                            <div>
                                                <span className="item-name" style={{ color: qualityColor(r.item.quality) }}>
                                                    {r.item.name ?? `Item #${r.item.item_id}`}
                                                </span>
                                                {r.crafted_quantity > 1 && (
                                                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 4 }}>
                                                        x{r.crafted_quantity}
                                                    </span>
                                                )}
                                                {r.item.item_subclass && (
                                                    <div className="item-id">{r.item.item_subclass}</div>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td>
                                        <div style={{ fontWeight: 500 }}>{r.recipe_name ?? `Recipe #${r.recipe_id}`}</div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                            {[r.profession_name, r.skill_tier_name].filter(Boolean).join(' · ')}
                                        </div>
                                    </td>
                                    <td>
                                        <GoldAmount copper={r.craft_cost} />
                                        {r.reagents.length > 0 && (
                                            <button
                                                style={{
                                                    display: 'block', marginTop: 4,
                                                    fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent-gold)',
                                                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                                }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onToggleExpand(r.recipe_id);
                                                }}
                                            >
                                                {isExpanded ? '▾' : '▸'} {r.reagents.length} reagents
                                            </button>
                                        )}
                                    </td>
                                    <td>
                                        <GoldAmount copper={r.best_realm.sell_price} />
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                            {r.best_realm.realm_name ?? `Realm ${r.best_realm.connected_realm_id}`}
                                            {' · '}{r.best_realm.market_quantity} listed
                                        </div>
                                    </td>
                                    <td style={{ fontWeight: 700 }}>
                                        <GoldAmount copper={r.margin} />
                                    </td>
                                    <td>
                                        <span className={`stat-badge ${r.margin > 0 ? 'positive' : 'negative'}`}>
                                            {r.margin_pct != null ? `${(r.margin_pct * 100).toFixed(0)}%` : '--'}
                                        </span>
                                    </td>
                                </tr>
                                {isExpanded && (
                                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                                        <td colSpan={6} style={{ padding: '8px 14px 12px 56px' }}>
                                            <table style={{ fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                                                <tbody>
                                                    {r.reagents.map((rg) => (
                                                        <tr key={rg.item_id}>
                                                            <td style={{ padding: '2px 16px 2px 0', color: 'var(--text-secondary)' }}>
                                                                {rg.quantity}&times; {rg.name ?? `Item #${rg.item_id}`}
                                                            </td>
                                                            <td style={{ padding: '2px 0' }}>
                                                                {rg.unit_price != null
                                                                    ? <GoldAmount copper={rg.unit_price * rg.quantity} />
                                                                    : <span style={{ color: 'var(--accent-red)' }}>no price</span>}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        );
                    })}

                    {recipes.length === 0 && (
                        <tr>
                            <td colSpan={6} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                {emptyMessage}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

export default function CraftPage() {
    const [data, setData] = useState<CraftResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Off by default: the professions API currently exposes no Decor-crafting
    // recipes — the toggle is future-proofing for when Blizzard adds them.
    const [decorOnly, setDecorOnly] = useState(false);
    const [profession, setProfession] = useState<number | undefined>();
    const [limit, setLimit] = useState(50);
    const [searchQuery, setSearchQuery] = useState('');
    const [expanded, setExpanded] = useState<Set<number>>(new Set());

    // Character lookup state
    const [realmList, setRealmList] = useState<RealmSlugEntry[]>([]);
    const [charName, setCharName] = useState('');
    const [charRealm, setCharRealm] = useState('');
    const [charData, setCharData] = useState<CharacterProfessions | null>(null);
    const [charLoading, setCharLoading] = useState(false);
    const [charError, setCharError] = useState<string | null>(null);

    const knownRecipeIds = useMemo(
        () => new Set(charData?.known_recipe_ids ?? []),
        [charData]
    );

    // Search debounce
    const searchTimeoutRef = useRef<NodeJS.Timeout>();
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        searchTimeoutRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300);
        return () => clearTimeout(searchTimeoutRef.current);
    }, [searchQuery]);

    const loadData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const result = await fetchCraftable({
                limit,
                decorOnly,
                profession,
                search: debouncedSearch || undefined,
            });
            setData(result);
        } catch (err: any) {
            setError(err.message || 'Failed to load data');
        } finally {
            setLoading(false);
        }
    }, [limit, decorOnly, profession, debouncedSearch]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    useEffect(() => {
        fetchRealmList().then(setRealmList).catch(() => { });
    }, []);

    const loadCharacter = useCallback(async (realmSlug: string, name: string) => {
        if (!realmSlug || name.trim().length < 2) return;
        try {
            setCharLoading(true);
            setCharError(null);
            const result = await fetchCharacter(realmSlug, name.trim());
            setCharData(result);
            try {
                localStorage.setItem(
                    CHARACTER_STORAGE_KEY,
                    JSON.stringify({ name: name.trim(), realmSlug })
                );
            } catch { }
        } catch (err: any) {
            setCharData(null);
            setCharError(err.message || 'Failed to load character');
        } finally {
            setCharLoading(false);
        }
    }, []);

    // Restore saved character on mount
    useEffect(() => {
        try {
            const saved = localStorage.getItem(CHARACTER_STORAGE_KEY);
            if (saved) {
                const { name, realmSlug } = JSON.parse(saved);
                if (name && realmSlug) {
                    setCharName(name);
                    setCharRealm(realmSlug);
                    loadCharacter(realmSlug, name);
                }
            }
        } catch { }
    }, [loadCharacter]);

    const clearCharacter = () => {
        setCharData(null);
        setCharError(null);
        try { localStorage.removeItem(CHARACTER_STORAGE_KEY); } catch { }
    };

    const toggleExpand = (recipeId: number) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(recipeId)) next.delete(recipeId);
            else next.add(recipeId);
            return next;
        });
    };

    // Split recipes by character knowledge
    const knownRecipes = useMemo(
        () => (data && charData ? data.recipes.filter(r => knownRecipeIds.has(r.recipe_id)) : []),
        [data, charData, knownRecipeIds]
    );
    const unknownRecipes = useMemo(
        () => (data && charData ? data.recipes.filter(r => !knownRecipeIds.has(r.recipe_id)) : []),
        [data, charData, knownRecipeIds]
    );

    const professionSummary = charData?.professions
        .map(p => p.profession_name)
        .filter(Boolean)
        .join(', ');

    return (
        <div className="page-container">
            {/* Header */}
            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <a
                        href="/"
                        style={{
                            color: 'var(--accent-gold)', textDecoration: 'none', fontSize: '0.85rem',
                            display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 8,
                        }}
                    >
                        &larr; Back to radar
                    </a>
                    <h1 className="page-title" style={{ margin: 0 }}>Craftable Margins</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
                        Cost to craft (region reagent prices) vs best realm to sell &mdash; after 5% AH cut.
                    </p>
                    {data && (
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {data.region.toUpperCase()} &middot; {data.total_count} recipes &middot; Updated {timeAgo(data.generated_at)}
                        </span>
                    )}
                </div>
            </div>

            {/* Character bar */}
            <div
                className="glass-card"
                style={{
                    padding: '12px 16px', marginBottom: 12,
                    display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                }}
            >
                {charData ? (
                    <>
                        <span style={{ fontSize: '0.9rem' }}>
                            Optimizing for{' '}
                            <strong style={{ color: 'var(--accent-gold)' }}>
                                {charData.character.name}
                            </strong>
                            <span style={{ color: 'var(--text-secondary)' }}>
                                -{realmList.find(r => r.slug === charData.character.realm_slug)?.name ?? charData.character.realm_slug}
                            </span>
                            {professionSummary && (
                                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 8 }}>
                                    {professionSummary} &middot; {charData.known_recipe_ids.length} recipes known
                                </span>
                            )}
                        </span>
                        <button className="btn btn-ghost" onClick={clearCharacter} style={{ marginLeft: 'auto' }}>
                            ✕ Clear
                        </button>
                    </>
                ) : (
                    <>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                            ⚔ Optimize for your character:
                        </span>
                        <input
                            type="text"
                            className="filter-input"
                            placeholder="Character name"
                            value={charName}
                            maxLength={12}
                            onChange={(e) => setCharName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') loadCharacter(charRealm, charName); }}
                            style={{ width: 150 }}
                        />
                        <select
                            className="filter-select"
                            value={charRealm}
                            onChange={(e) => setCharRealm(e.target.value)}
                        >
                            <option value="">Select realm...</option>
                            {realmList.map((r) => (
                                <option key={r.slug} value={r.slug}>{r.name}</option>
                            ))}
                        </select>
                        <button
                            className="btn btn-primary"
                            onClick={() => loadCharacter(charRealm, charName)}
                            disabled={charLoading || !charRealm || charName.trim().length < 2}
                        >
                            {charLoading ? 'Loading...' : 'Load'}
                        </button>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            Uses public profile data &mdash; no login needed.
                        </span>
                    </>
                )}
                {charError && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--accent-red)', width: '100%' }}>
                        {charError}
                    </span>
                )}
            </div>

            {/* Filters */}
            <div className="filter-bar">
                <select
                    className="filter-select"
                    value={profession ?? ''}
                    onChange={(e) => setProfession(e.target.value ? Number(e.target.value) : undefined)}
                >
                    <option value="">All Professions</option>
                    {data?.professions.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>

                <label
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer',
                        userSelect: 'none',
                    }}
                >
                    <input
                        type="checkbox"
                        checked={decorOnly}
                        onChange={(e) => setDecorOnly(e.target.checked)}
                    />
                    Decor only
                </label>

                <select
                    className="filter-select"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                >
                    <option value={25}>Show 25</option>
                    <option value={50}>Show 50</option>
                    <option value={100}>Show 100</option>
                    <option value={200}>Show 200</option>
                </select>

                <input
                    type="text"
                    className="filter-input"
                    placeholder="Search recipes or items..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{ minWidth: 180 }}
                />

                <button className="btn btn-ghost" onClick={loadData} title="Re-fetch latest data">
                    ↻ Refresh
                </button>
            </div>

            {/* Error */}
            {error && (
                <div
                    style={{
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: 'var(--radius-md)',
                        padding: '12px 16px',
                        marginBottom: 16,
                        color: 'var(--accent-red)',
                        fontSize: '0.85rem',
                    }}
                >
                    {error}
                </div>
            )}

            {/* Loading skeleton */}
            {loading && !data && (
                <div className="data-table-wrapper">
                    <table className="data-table">
                        <thead>
                            <tr>
                                {['Item', 'Recipe', 'Craft Cost', 'Sell (Best Realm)', 'Margin', 'Margin %'].map((h) => (
                                    <th key={h}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {Array.from({ length: 10 }).map((_, i) => (
                                <tr key={i}>
                                    {Array.from({ length: 6 }).map((_, j) => (
                                        <td key={j}>
                                            <div className="skeleton" style={{ height: 18, width: 60 + (i % 5) * 15 }} />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Tables */}
            {data && (
                <div style={{ opacity: loading ? 0.6 : 1 }}>
                    {charData ? (
                        <>
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-emerald)', margin: '8px 0' }}>
                                ✔ You can craft these now ({knownRecipes.length})
                            </h3>
                            <RecipeTable
                                recipes={knownRecipes}
                                expanded={expanded}
                                onToggleExpand={toggleExpand}
                                emptyMessage="None of the listed recipes are known by this character. Try widening the filters."
                            />
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-gold)', margin: '20px 0 8px' }}>
                                📈 Worth learning next ({unknownRecipes.length})
                            </h3>
                            <RecipeTable
                                recipes={unknownRecipes}
                                expanded={expanded}
                                onToggleExpand={toggleExpand}
                                emptyMessage="No unlearned recipes with complete pricing match the filters."
                            />
                        </>
                    ) : (
                        <RecipeTable
                            recipes={data.recipes}
                            expanded={expanded}
                            onToggleExpand={toggleExpand}
                            emptyMessage={
                                decorOnly
                                    ? 'No decor-crafting recipes exist in the professions catalog yet — uncheck "Decor only" to see all craftable margins.'
                                    : 'No craftable recipes with complete pricing found. The recipe catalog may not be ingested yet.'
                            }
                        />
                    )}
                </div>
            )}

            {/* Footer */}
            {data && (
                <div
                    style={{
                        marginTop: 16, padding: '12px 0', fontSize: '0.75rem',
                        color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between',
                        borderTop: '1px solid var(--border-subtle)',
                    }}
                >
                    <span>
                        Reagents priced from region-wide commodity auctions, vendor prices, or cheapest realm AH.
                    </span>
                    <span>
                        Margin = sell &times; qty &times; {(1 - data.ah_cut) * 100}% &minus; craft cost. Recipes with unpriced reagents are hidden.
                    </span>
                </div>
            )}
        </div>
    );
}
