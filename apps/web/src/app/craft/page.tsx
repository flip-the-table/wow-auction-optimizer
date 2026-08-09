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
    formatGoldCompact,
    nextRefreshLabel,
    qualityColor,
    timeAgo,
} from '@/lib/api';
import { SiteNav, Gold, SortableTh, useTableSort } from '@/components/market-widgets';

const CHARACTER_STORAGE_KEY = 'ftt-character';


// --- Verdict chip: turn margin stats into a plain-language recommendation ---
function CraftVerdict({ r, useUserRealm }: { r: CraftRecipe; useUserRealm: boolean }) {
    const margin = useUserRealm && r.user_margin != null ? r.user_margin : r.margin;
    const pct = r.craft_cost > 0 ? margin / r.craft_cost : null;
    if (pct === null) return <span className="stat-badge neutral">—</span>;
    // A huge margin on a market where nothing actually sells is a lottery
    // ticket, not an opportunity — call it what it is.
    if ((r.est_sales_per_day ?? 0) < 0.1 && pct > 0) {
        return (
            <span
                className="stat-badge neutral"
                title="Listings on this market almost never sell (near-zero churn) — the posted price is aspirational."
                style={{ whiteSpace: 'nowrap' }}
            >
                🎰 Rarely sells
            </span>
        );
    }
    const where = useUserRealm && r.user_margin != null ? 'on your realm' : 'on the best realm';
    const pctText = pct >= 9.995 ? '+999%+' : `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(0)}%`;
    let label: string, cls: string, title: string;
    if (pct >= 0.5) {
        label = `🔥 Craft now ${pctText}`;
        cls = 'positive';
        title = `High margin: each craft returns ${(pct * 100).toFixed(0)}% over material cost ${where}.`;
    } else if (pct >= 0.15) {
        label = `✅ Profitable ${pctText}`;
        cls = 'positive';
        title = `Solid margin of ${pctText} over material cost ${where}.`;
    } else if (pct >= 0) {
        label = `➖ Thin ${pctText}`;
        cls = 'neutral';
        title = `Margin of only ${pctText} ${where} — one undercut from a loss.`;
    } else {
        label = `🚫 Loss ${pctText}`;
        cls = 'negative';
        title = `Crafting costs more than it sells for ${where}.`;
    }
    return <span className={`stat-badge ${cls}`} title={title} style={{ whiteSpace: 'nowrap' }}>{label}</span>;
}

// --- Recipe Margin Table ---
function RecipeTable({
    recipes,
    expanded,
    onToggleExpand,
    emptyMessage,
    showUserRealm,
    userRealmName,
}: {
    recipes: CraftRecipe[];
    expanded: Set<number>;
    onToggleExpand: (recipeId: number) => void;
    emptyMessage: string;
    showUserRealm: boolean;
    userRealmName?: string;
}) {
    const router = useRouter();
    const colCount = showUserRealm ? 6 : 5;
    // Server order = expected gold/day; header clicks rearrange client-side
    const { sorted, sortKey, sortDir, toggle } = useTableSort(
        recipes,
        {
            name: r => r.item.name,
            cost: r => r.craft_cost,
            sell: r => r.best_realm.sell_price,
            user: r => r.user_margin,
            margin: r => r.margin,
        },
        'server'
    );
    return (
        <div className="data-table-wrapper fade-in">
            <table className="data-table">
                <thead>
                    <tr>
                        <SortableTh label="Item" k="name" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="The crafted item, its profession and expansion tier" />
                        <SortableTh label="Craft Cost" k="cost" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Sum of reagent costs (region commodity prices, vendor prices, or cheapest realm AH)" />
                        <SortableTh label="Sell (Best Realm)" k="sell" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Median buyout on the best realm with a real market (3+ listings, price within 5x the cross-realm median)" />
                        {showUserRealm && (
                            <SortableTh label="Your Realm" k="user" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title={`Sell price and margin on ${userRealmName ?? 'your realm'} — where you can actually post`} />
                        )}
                        <SortableTh label="Margin" k="margin" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} title="Sell price x quantity x 0.95 (AH cut) - craft cost, on the best realm" />
                        <th title="Plain-language recommendation based on margin % over cost">Verdict</th>
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((r: CraftRecipe) => {
                        const isExpanded = expanded.has(r.recipe_id);
                        return (
                            <React.Fragment key={r.recipe_id}>
                                <tr
                                    onClick={() => r.item.item_id && router.push(`/item/${r.item.item_id}`)}
                                    style={{ cursor: r.item.item_id ? 'pointer' : 'default' }}
                                >
                                    <td>
                                        <div className="item-cell" title={r.recipe_name ?? undefined}>
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
                                                <div className="item-id">
                                                    {[r.profession_name, r.skill_tier_name].filter(Boolean).join(' · ')
                                                        || r.item.item_subclass}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td>
                                        <Gold copper={r.craft_cost} />
                                        {r.cost_basis === 'base' && (
                                            <span
                                                style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginLeft: 4 }}
                                                title="Modern recipe: Blizzard's API omits quality-reagent slots, so this covers base reagents only — actual cost runs somewhat higher."
                                            >
                                                +mats
                                            </span>
                                        )}
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
                                        <Gold copper={r.best_realm.sell_price} />
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                            {r.best_realm.realm_name ?? `Realm ${r.best_realm.connected_realm_id}`}
                                            {' · '}{r.best_realm.market_quantity} listed
                                        </div>
                                        {(r.est_sales_per_day ?? 0) >= 0.1 && (r.best_realm.market_quantity ?? 0) > 0 && (
                                            <div
                                                style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 1 }}
                                                title="Current stock ÷ observed removals per day — roughly how long the queue is before a fresh craft sells."
                                            >
                                                ⏳ queue ~{(r.best_realm.market_quantity / r.est_sales_per_day!).toFixed(r.best_realm.market_quantity / r.est_sales_per_day! >= 10 ? 0 : 1)}d
                                            </div>
                                        )}
                                    </td>
                                    {showUserRealm && (
                                        <td>
                                            {r.user_sell_price != null ? (
                                                <>
                                                    <Gold copper={r.user_sell_price} />
                                                    <div style={{ fontSize: '0.72rem', marginTop: 2, color: (r.user_margin ?? 0) > 0 ? 'var(--accent-emerald)' : 'var(--accent-red)' }}>
                                                        margin: <Gold copper={r.user_margin ?? null} />
                                                    </div>
                                                </>
                                            ) : (
                                                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }} title="This item has no listings on your realm — you could be first, but there's no price signal">
                                                    not listed
                                                </span>
                                            )}
                                        </td>
                                    )}
                                    <td style={{ fontWeight: 700 }}>
                                        <Gold copper={r.margin} />
                                        {(r.expected_daily_gold ?? 0) > 0 && (
                                            <div
                                                style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)', marginTop: 2 }}
                                                title={`~${(r.est_sales_per_day ?? 0).toFixed(1)}/day removed before expiry (sold or cancelled) observed on the best realm`}
                                            >
                                                ~{formatGoldCompact(r.expected_daily_gold ?? 0)}g / day est
                                            </div>
                                        )}
                                    </td>
                                    <td>
                                        <CraftVerdict r={r} useUserRealm={showUserRealm} />
                                    </td>
                                </tr>
                                {isExpanded && (
                                    <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                                        <td colSpan={colCount} style={{ padding: '8px 14px 12px 56px' }}>
                                            <table style={{ fontSize: '0.78rem', borderCollapse: 'collapse' }}>
                                                <tbody>
                                                    {r.reagents.map((rg) => (
                                                        <tr key={rg.item_id}>
                                                            <td style={{ padding: '2px 16px 2px 0', color: 'var(--text-secondary)' }}>
                                                                {rg.quantity}&times; {rg.name ?? `Item #${rg.item_id}`}
                                                            </td>
                                                            <td style={{ padding: '2px 0' }}>
                                                                {rg.unit_price != null
                                                                    ? <Gold copper={rg.unit_price * rg.quantity} />
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
                            <td colSpan={colCount} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
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
    // Off by default: markets with zero observed removals are lottery listings,
    // not opportunities — surfacing them buried every real earner.
    const [includeInactive, setIncludeInactive] = useState(false);
    // Off by default: legacy-expansion recipes are noise unless they craft
    // Decor (which flips regardless of expansion).
    const [includeOldXpacs, setIncludeOldXpacs] = useState(false);
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

    // The user's connected realm — unlocks "Your Realm" margins
    const userRealmEntry = useMemo(
        () => (charData ? realmList.find(r => r.slug === charData.character.realm_slug) : undefined),
        [charData, realmList]
    );
    const userRealmId = userRealmEntry?.connected_realm_id;

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
                realm: userRealmId,
                includeInactive,
                includeOldXpacs,
                charRealm: charData?.character.realm_slug,
                charName: charData?.character.name,
            });
            setData(result);
        } catch (err: any) {
            setError(err.message || 'Failed to load data');
        } finally {
            setLoading(false);
        }
    }, [limit, decorOnly, profession, debouncedSearch, userRealmId, includeInactive, includeOldXpacs, charData]);

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

    // Known recipes come from the API when it resolved the character (queried
    // against the FULL catalog — intersecting the top-N client-side found
    // nothing for most characters). Fallback: client-side intersection.
    const knownRecipes = useMemo(() => {
        if (!data || !charData) return [];
        if (data.known_recipes) return data.known_recipes;
        return data.recipes.filter(r => knownRecipeIds.has(r.recipe_id));
    }, [data, charData, knownRecipeIds]);
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
            <SiteNav />
            {/* Header */}
            <div className="page-header" style={{ alignItems: 'baseline' }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>Craftable Margins</h1>
                    <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
                        Cost to craft (region reagent prices) vs best realm to sell &mdash; after 5% AH cut.
                    </p>
                    {/* Always rendered — popping in after fetch shifted the whole page (CLS) */}
                    <span style={{ display: 'block', minHeight: '1.2em', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        {data
                            ? <>{data.region.toUpperCase()} &middot; {data.total_count} recipes &middot; Updated {timeAgo(data.generated_at)} &middot; Next data ~{nextRefreshLabel()}</>
                            : ' '}
                    </span>
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

                <label
                    title="Also show markets where no listing has been observed to sell — huge margins on paper that nobody actually collects."
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer',
                        userSelect: 'none',
                    }}
                >
                    <input
                        type="checkbox"
                        checked={includeInactive}
                        onChange={(e) => setIncludeInactive(e.target.checked)}
                    />
                    🎰 Include no-sale markets
                </label>

                <label
                    title="Also show recipes from past expansions. Decor from any expansion is always included — flipping furniture is the whole point."
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer',
                        userSelect: 'none',
                    }}
                >
                    <input
                        type="checkbox"
                        checked={includeOldXpacs}
                        onChange={(e) => setIncludeOldXpacs(e.target.checked)}
                    />
                    🕰 Include old expansions
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
                                {['Item', 'Craft Cost', 'Sell (Best Realm)', 'Margin', 'Verdict'].map((h) => (
                                    <th key={h}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {Array.from({ length: 10 }).map((_, i) => (
                                <tr key={i}>
                                    {Array.from({ length: 5 }).map((_, j) => (
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
                            {knownRecipes.length > 0 ? (
                                <RecipeTable
                                    recipes={knownRecipes}
                                    expanded={expanded}
                                    onToggleExpand={toggleExpand}
                                    emptyMessage=""
                                    showUserRealm={userRealmId != null}
                                    userRealmName={userRealmEntry?.name}
                                />
                            ) : (
                                <div
                                    className="glass-card"
                                    style={{ padding: '14px 18px', fontSize: '0.85rem', color: 'var(--text-muted)' }}
                                >
                                    {(charData.known_recipe_ids?.length ?? 0) === 0
                                        ? `${charData.character.name} has no profession recipes on their public profile.`
                                        : 'None of this character’s known recipes have complete pricing and a live market right now — check back after the next data refresh, or adjust the filters.'}
                                </div>
                            )}
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-gold)', margin: '20px 0 8px' }}>
                                📈 Worth learning next ({unknownRecipes.length})
                            </h3>
                            <RecipeTable
                                recipes={unknownRecipes}
                                expanded={expanded}
                                onToggleExpand={toggleExpand}
                                emptyMessage="No unlearned recipes with complete pricing match the filters."
                                showUserRealm={userRealmId != null}
                                userRealmName={userRealmEntry?.name}
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
                                    : !includeOldXpacs || !includeInactive
                                        ? 'Nothing matches the default view (current expansion, markets with observed sales). Try "🕰 Include old expansions" or "🎰 Include no-sale markets" — or check back after the next data refresh.'
                                        : 'No craftable recipes with complete pricing found. The recipe catalog may not be ingested yet.'
                            }
                            showUserRealm={userRealmId != null}
                            userRealmName={userRealmEntry?.name}
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
