import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 1800; // data refreshes once daily

const AH_CUT = 0.05; // 5% auction house cut

function intParam(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);

    const limit = Math.min(Math.max(intParam(searchParams.get('limit'), 50), 1), 500);
    const decorOnly = searchParams.get('all') !== '1';
    const professionRaw = intParam(searchParams.get('profession'), NaN);
    const profession = Number.isFinite(professionRaw) ? professionRaw : null;
    const search = searchParams.get('search') || null;

    let searchPattern: string | null = null;
    if (search) {
      const sanitized = search.replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      if (sanitized.length > 0) searchPattern = `%${sanitized}%`;
    }

    const cacheKey = `craft:${region}:${limit}:${decorOnly}:${profession ?? 'all'}:${searchPattern ?? ''}`;
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

    const decorFilter = decorOnly ? sql`AND i.item_subclass = 'Decor'` : sql``;
    const professionFilter = profession !== null ? sql`AND r.profession_id = ${profession}` : sql``;
    const searchFilter = searchPattern
      ? sql`AND (i.name ILIKE ${searchPattern} OR r.name ILIKE ${searchPattern})`
      : sql``;

    // Recipes with complete costs, joined to the best realm to sell the crafted
    // item (highest median). Margin = revenue per craft after AH cut - cost.
    const rows = await sql`
      WITH sellable AS (
        SELECT
          rc.recipe_id,
          rc.crafted_item_id,
          rc.craft_cost,
          rc.reagents_priced,
          rc.reagents_total,
          r.name as recipe_name,
          r.profession_id,
          r.profession_name,
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
        WHERE rc.region = ${region}
          AND rc.craft_cost IS NOT NULL
          AND rc.craft_cost > 0
          AND rc.reagents_priced = rc.reagents_total
          ${decorFilter}
          ${professionFilter}
          ${searchFilter}
      ),
      best AS (
        SELECT DISTINCT ON (s.recipe_id)
          s.*,
          a.connected_realm_id,
          a.median_buyout as sell_price,
          a.total_quantity as market_quantity,
          a.listing_count as market_listings,
          ri.name as realm_name
        FROM sellable s
        JOIN item_realm_aggregates a
          ON a.region = ${region} AND a.item_id = s.crafted_item_id
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) as name
          FROM realms GROUP BY connected_realm_id
        ) ri ON a.connected_realm_id = ri.connected_realm_id
        WHERE a.median_buyout IS NOT NULL AND a.median_buyout > 0
        ORDER BY s.recipe_id, a.median_buyout DESC
      )
      SELECT
        *,
        (sell_price * crafted_quantity * ${1 - AH_CUT} - craft_cost)::bigint as margin
      FROM best
      ORDER BY margin DESC
      LIMIT ${limit}
    `;

    // Reagent breakdown for the returned recipes (one batch query)
    const recipeIds = rows.map((r: any) => r.recipe_id);
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

    const recipes = rows.map((row: any) => ({
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
    }));

    // Profession list for the filter dropdown (cheap, cached with response)
    const professionRows = await sql`
      SELECT DISTINCT profession_id, profession_name
      FROM recipes WHERE profession_name IS NOT NULL
      ORDER BY profession_name
    `;

    const responseBody = {
      recipes,
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
      { error: error.message || 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
