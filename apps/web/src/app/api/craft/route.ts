import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';
import { getCharacterProfile } from '@/lib/blizzard';

export const runtime = 'nodejs';

const CACHE_TTL = 1800; // data refreshes once daily

const AH_CUT = 0.05; // 5% auction house cut

// Skill tiers >= this are "modified crafting" era (Dragonflight onward:
// 2822+; legacy tiers sit at 2437-2477, Shadowlands at 2751). Blizzard's
// recipe API omits the quality-reagent slots for these, so their craft
// costs cover base reagents only — flagged so the UI can say so.
const MODIFIED_CRAFTING_TIER = 2800;

function intParam(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);

    const limit = Math.min(Math.max(intParam(searchParams.get('limit'), 50), 1), 500);
    // Default: all recipes. The professions API exposes zero Decor-crafting
    // recipes today (verified via debug=2 breakdown) — the filter stays as an
    // opt-in for when/if Blizzard adds housing recipes to the catalog.
    const decorOnly = searchParams.get('decor') === '1';
    const professionRaw = intParam(searchParams.get('profession'), NaN);
    const profession = Number.isFinite(professionRaw) ? professionRaw : null;
    // Optional: the user's connected realm — adds "your realm" sell/margin
    const userRealmRaw = intParam(searchParams.get('realm'), NaN);
    const userRealm = Number.isFinite(userRealmRaw) ? userRealmRaw : null;
    const search = searchParams.get('search') || null;
    // Default view: only markets with observed sales evidence. active=0 also
    // includes markets where listings never move (huge margins nobody collects).
    const activeOnly = searchParams.get('active') !== '0';
    // Default view: current-expansion recipes only — except Decor, which is
    // the app's core flipping business regardless of expansion. xpac=all opts
    // into legacy recipes. "Current" is data-derived per profession (its
    // newest skill tier), never a hardcoded expansion name.
    const currentOnly = searchParams.get('xpac') !== 'all';
    // Optional character: adds a "known recipes" result set queried from the
    // full catalog (the top-N list alone almost never intersects what one
    // character happens to know).
    const charRealm = (searchParams.get('charRealm') || '').toLowerCase().trim();
    const charName = (searchParams.get('charName') || '').trim();
    const hasChar =
      /^[a-z0-9-]{2,64}$/.test(charRealm) && charName.length >= 2 && charName.length <= 12;

    let searchPattern: string | null = null;
    if (search) {
      const sanitized = search.replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      if (sanitized.length > 0) searchPattern = `%${sanitized}%`;
    }

    const charKey = hasChar ? `${charRealm}:${charName.toLowerCase()}` : 'none';
    const cacheKey = `craft:${region}:${limit}:${decorOnly}:${profession ?? 'all'}:${userRealm ?? 'none'}:${searchPattern ?? ''}:${activeOnly ? 1 : 0}:${currentOnly ? 1 : 0}:${charKey}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();

    // Diagnostic modes are ops-only: require a server-side token. With no
    // DEBUG_ROUTES_TOKEN configured they are disabled entirely.
    const debugParam = searchParams.get('debug');
    if (debugParam) {
      const token = process.env.DEBUG_ROUTES_TOKEN;
      const provided = request.headers.get('x-debug-token');
      if (!token || provided !== token) {
        return NextResponse.json({ error: 'not found' }, {
          status: 404, headers: { 'Cache-Control': 'no-store' },
        });
      }
    }

    // Diagnostic mode: stage-by-stage funnel counts (never cached)
    if (debugParam === '1') {
      const [funnel] = await sql`
        SELECT
          (SELECT COUNT(*) FROM recipes) as recipes_total,
          (SELECT COUNT(*) FROM recipes WHERE crafted_item_id IS NOT NULL) as recipes_with_item,
          (SELECT COUNT(*) FROM recipe_costs WHERE region = ${region}) as costs_rows,
          (SELECT COUNT(*) FROM recipe_costs WHERE region = ${region}
            AND craft_cost > 0 AND reagents_priced = reagents_total) as costs_complete,
          (SELECT COUNT(*) FROM recipe_costs rc JOIN items i ON i.id = rc.crafted_item_id
            WHERE rc.region = ${region} AND i.item_subclass = 'Decor') as decor_costed,
          (SELECT COUNT(*) FROM recipe_costs rc JOIN items i ON i.id = rc.crafted_item_id
            WHERE rc.region = ${region} AND i.item_subclass = 'Decor'
            AND rc.craft_cost > 0 AND rc.reagents_priced = rc.reagents_total) as decor_complete,
          (SELECT COUNT(*) FROM recipe_costs rc
            WHERE rc.region = ${region} AND EXISTS (
              SELECT 1 FROM item_realm_aggregates a
              WHERE a.region = ${region} AND a.item_id = rc.crafted_item_id AND a.median_buyout > 0
            )) as costed_with_market,
          (SELECT COUNT(*) FROM recipes r WHERE r.crafted_item_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = r.crafted_item_id)) as crafted_unresolved
      `;
      return NextResponse.json(funnel, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Diagnostic mode 2: what item classes do profession recipes actually craft?
    if (debugParam === '2') {
      const breakdown = await sql`
        SELECT
          COALESCE(i.item_class, '(unresolved)') as item_class,
          COALESCE(i.item_subclass, '(unresolved)') as item_subclass,
          COUNT(*) as recipe_count
        FROM recipes r
        LEFT JOIN items i ON i.id = r.crafted_item_id
        WHERE r.crafted_item_id IS NOT NULL
        GROUP BY 1, 2
        ORDER BY recipe_count DESC
        LIMIT 25
      `;
      return NextResponse.json(
        breakdown.map((b: any) => ({ ...b, recipe_count: Number(b.recipe_count) })),
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const decorFilter = decorOnly ? sql`AND i.item_subclass = 'Decor'` : sql``;
    const professionFilter = profession !== null ? sql`AND r.profession_id = ${profession}` : sql``;
    const searchFilter = searchPattern
      ? sql`AND (i.name ILIKE ${searchPattern} OR r.name ILIKE ${searchPattern})`
      : sql``;

    // Recipes with complete costs, joined to the best realm to sell the crafted
    // item (highest median). Margin = revenue per craft after AH cut - cost.
    // knownFilter narrows to a character's known recipes; activeFilter drops
    // markets with no observed removals (applied to the global list only —
    // a character's own toolkit is small enough to show in full).
    const queryRecipes = (knownIds: number[] | null, active: boolean, rowLimit: number) => sql`
      WITH current_tier AS (
        -- Each profession's newest skill tier = its current expansion
        SELECT profession_id, MAX(skill_tier_id) AS tier_id
        FROM recipes GROUP BY profession_id
      ),
      sellable AS (
        SELECT DISTINCT ON (rc.crafted_item_id)
          rc.recipe_id,
          rc.crafted_item_id,
          rc.craft_cost,
          rc.reagents_priced,
          rc.reagents_total,
          r.name as recipe_name,
          r.profession_id,
          r.profession_name,
          r.skill_tier_id,
          r.skill_tier_name,
          r.crafted_quantity,
          i.name as item_name,
          i.quality as item_quality,
          i.item_subclass,
          m.icon_url
        FROM recipe_costs rc
        JOIN recipes r ON r.id = rc.recipe_id
        LEFT JOIN items i ON i.id = rc.crafted_item_id
        LEFT JOIN item_media m ON m.item_id = rc.crafted_item_id
        ${currentOnly && !knownIds ? sql`
        JOIN current_tier ct ON ct.profession_id = r.profession_id` : sql``}
        WHERE rc.region = ${region}
          AND rc.craft_cost IS NOT NULL
          AND rc.craft_cost > 0
          AND rc.reagents_priced = rc.reagents_total
          ${currentOnly && !knownIds
            ? sql`AND (r.skill_tier_id = ct.tier_id OR i.item_subclass = 'Decor')`
            : sql``}
          ${knownIds ? sql`AND rc.recipe_id = ANY(${knownIds})` : sql``}
          ${decorFilter}
          ${professionFilter}
          ${searchFilter}
        ORDER BY rc.crafted_item_id, rc.craft_cost ASC
      ),
      best AS (
        -- recipe_market is precomputed by the compute job — touching the large
        -- aggregates table at request time caused 504s on the small instance.
        -- ua: the user's realm market (PK lookup; -1 sentinel matches nothing).
        SELECT
          s.*,
          bm.connected_realm_id,
          bm.sell_price,
          bm.market_quantity,
          bm.market_listings,
          COALESCE(bm.demand_per_day, 0) as demand_per_day,
          ri.name as realm_name,
          ua.median_buyout as user_sell_price,
          ua.total_quantity as user_market_quantity
        FROM sellable s
        JOIN recipe_market bm
          ON bm.region = ${region} AND bm.crafted_item_id = s.crafted_item_id
          ${active ? sql`AND bm.demand_per_day >= 0.1` : sql``}
        LEFT JOIN item_realm_aggregates ua
          ON ua.region = ${region}
         AND ua.connected_realm_id = ${userRealm ?? -1}
         AND ua.item_id = s.crafted_item_id
         AND ua.median_buyout > 0
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) as name
          FROM realms GROUP BY connected_realm_id
        ) ri ON bm.connected_realm_id = ri.connected_realm_id
      )
      SELECT
        *,
        (sell_price * crafted_quantity * ${1 - AH_CUT} - craft_cost)::bigint as margin,
        (user_sell_price * crafted_quantity * ${1 - AH_CUT} - craft_cost)::bigint as user_margin,
        -- Expected gold/day: per-unit profit x est. units sold/day. Lottery
        -- listings (huge margin, zero churn) rank last where they belong.
        ((sell_price::float * ${1 - AH_CUT}::float - craft_cost / GREATEST(crafted_quantity, 0.01)) * demand_per_day)::bigint
          as expected_daily_gold
      FROM best
      ORDER BY expected_daily_gold DESC NULLS LAST, margin DESC
      LIMIT ${rowLimit}
    `;

    // Character profile fetch and the global list are independent — overlap them
    const [rows, charProfile] = await Promise.all([
      queryRecipes(null, activeOnly, limit),
      hasChar
        ? getCharacterProfile(charRealm, charName).catch(() => null)
        : Promise.resolve(null),
    ]);

    const knownIds: number[] = charProfile?.known_recipe_ids ?? [];
    const knownRows =
      knownIds.length > 0 ? await queryRecipes(knownIds, false, 200) : [];

    // Reagent breakdown for the returned recipes (one batch query)
    const recipeIds = Array.from(
      new Set([...rows, ...knownRows].map((r: any) => r.recipe_id))
    );
    const reagentsMap = new Map<number, any[]>();
    if (recipeIds.length > 0) {
      const reagentRows = await sql`
        SELECT
          rr.recipe_id,
          rr.reagent_item_id,
          rr.quantity,
          i.name as reagent_name,
          COALESCE(
            c.median_unit_price,
            NULLIF(i.purchase_price, 0),
            (SELECT MIN(a.median_buyout) FROM item_realm_aggregates a
             WHERE a.region = ${region} AND a.item_id = rr.reagent_item_id)
          ) as unit_price
        FROM recipe_reagents rr
        LEFT JOIN items i ON i.id = rr.reagent_item_id
        LEFT JOIN region_commodities c
          ON c.region = ${region} AND c.item_id = rr.reagent_item_id
        WHERE rr.recipe_id = ANY(${recipeIds})
      `;
      for (const rg of reagentRows) {
        if (!reagentsMap.has(rg.recipe_id)) reagentsMap.set(rg.recipe_id, []);
        reagentsMap.get(rg.recipe_id)!.push({
          item_id: rg.reagent_item_id,
          name: rg.reagent_name,
          quantity: Number(rg.quantity),
          unit_price: rg.unit_price != null ? Number(rg.unit_price) : null,
        });
      }
    }

    const mapRow = (row: any) => ({
      recipe_id: row.recipe_id,
      recipe_name: row.recipe_name,
      profession_id: row.profession_id,
      profession_name: row.profession_name,
      skill_tier_name: row.skill_tier_name,
      crafted_quantity: Number(row.crafted_quantity ?? 1),
      item: {
        item_id: row.crafted_item_id,
        name: row.item_name,
        quality: row.item_quality,
        icon_url: row.icon_url,
        item_subclass: row.item_subclass,
      },
      craft_cost: Number(row.craft_cost),
      cost_basis: Number(row.skill_tier_id) >= MODIFIED_CRAFTING_TIER ? 'base' : 'full',
      reagents: reagentsMap.get(row.recipe_id) ?? [],
      best_realm: {
        connected_realm_id: row.connected_realm_id,
        realm_name: row.realm_name,
        sell_price: Number(row.sell_price),
        market_quantity: Number(row.market_quantity),
        market_listings: Number(row.market_listings),
      },
      margin: Number(row.margin),
      margin_pct: Number(row.craft_cost) > 0 ? Number(row.margin) / Number(row.craft_cost) : null,
      user_sell_price: row.user_sell_price != null ? Number(row.user_sell_price) : null,
      user_market_quantity: row.user_market_quantity != null ? Number(row.user_market_quantity) : null,
      user_margin: row.user_margin != null ? Number(row.user_margin) : null,
      est_sales_per_day: Number(row.demand_per_day ?? 0),
      expected_daily_gold: Number(row.expected_daily_gold ?? 0),
    });

    const recipes = rows.map(mapRow);
    const knownRecipes = knownRows.map(mapRow);

    // Profession list for the filter dropdown (cheap, cached with response)
    const professionRows = await sql`
      SELECT DISTINCT profession_id, profession_name
      FROM recipes WHERE profession_name IS NOT NULL
      ORDER BY profession_name
    `;

    const responseBody = {
      recipes,
      // Present only when a character was requested AND its profile resolved —
      // absent means the client should fall back to client-side intersection.
      ...(charProfile
        ? { known_recipes: knownRecipes, known_recipe_count: knownIds.length }
        : {}),
      professions: professionRows.map((p: any) => ({
        id: p.profession_id,
        name: p.profession_name,
      })),
      total_count: recipes.length,
      region,
      ah_cut: AH_CUT,
      generated_at: new Date().toISOString(),
    };

    await cacheSet(cacheKey, responseBody, CACHE_TTL);

    return NextResponse.json(responseBody, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Craft API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
