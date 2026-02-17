import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 300; // 5 minutes

export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);

    const mode = searchParams.get('mode') || 'both';
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50'), 1), 500);
    const minConfidence = parseFloat(searchParams.get('minConfidence') || '0');
    const realm = searchParams.get('realm') ? parseInt(searchParams.get('realm')!) : null;
    const search = searchParams.get('search') || null;

    // --- Cache check ---
    const cacheKey = `hot:${region}:${mode}:${limit}:${realm ?? 'all'}:${minConfidence}:${search ?? ''}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();
    const sortCol = 'f.hotness_score';

    // Build WHERE conditions
    // Note: region is from env var (safe), minConfidence/realm are parsed numbers (safe)
    // search is user input — sanitize strictly beyond just quote escaping
    let whereConditions = [`f.region = '${region}'`];
    whereConditions.push(`i.item_subclass = 'Decor'`);
    if (minConfidence > 0) whereConditions.push(`f.confidence >= ${minConfidence}`);
    if (realm !== null) whereConditions.push(`f.connected_realm_id = ${realm}`);
    if (search) {
      // Strip everything except alphanumeric, spaces, hyphens, apostrophes
      const sanitized = search.replace(/[^a-zA-Z0-9 '\-]/g, '').replace(/'/g, "''");
      if (sanitized.length > 0) {
        whereConditions.push(`i.name ILIKE '%${sanitized}%'`);
      }
    }
    const whereClause = whereConditions.join(' AND ');

    // --- SINGLE BATCH QUERY: main data + realm names + counts ---
    // No more N+1! Realm names, total counts, and hot counts are inlined.
    let query: string;

    if (realm === null) {
      query = `
      WITH best_per_item AS (
        SELECT
          f.item_id,
          MAX(${sortCol}) as best_score
        FROM item_realm_features_latest f
        WHERE f.region = '${region}'
        GROUP BY f.item_id
      ),
      realm_info AS (
        SELECT connected_realm_id, MIN(name) as name
        FROM realms
        GROUP BY connected_realm_id
      )
      SELECT
        f.item_id,
        f.connected_realm_id,
        f.current_price,
        f.current_demand,
        f.price_pct_diff,
        f.demand_pct_diff,
        f.price_z,
        f.demand_z,
        f.hotness_score,
        f.confidence,
        f.listing_count,
        f.total_quantity,
        f.baseline_window_days,
        f.updated_at,
        f.sell_suitability_score,
        i.name as item_name,
        i.quality as item_quality,
        i.level as item_level,
        i.item_class,
        i.item_subclass,
        m.icon_url,
        ri.name as realm_name,
        (SELECT COUNT(DISTINCT connected_realm_id)
         FROM item_realm_aggregates WHERE item_id = f.item_id AND region = f.region) as total_realm_count,
        (SELECT COUNT(DISTINCT connected_realm_id)
         FROM item_realm_features_latest WHERE item_id = f.item_id AND region = f.region) as hot_realm_count
      FROM item_realm_features_latest f
      JOIN best_per_item b ON f.item_id = b.item_id AND ${sortCol} = b.best_score
      LEFT JOIN items i ON f.item_id = i.id
      LEFT JOIN item_media m ON f.item_id = m.item_id
      LEFT JOIN realm_info ri ON f.connected_realm_id = ri.connected_realm_id
      WHERE ${whereClause}
      ORDER BY ${sortCol} DESC
      LIMIT ${limit}
    `;
    } else {
      query = `
      WITH realm_info AS (
        SELECT connected_realm_id, MIN(name) as name
        FROM realms
        GROUP BY connected_realm_id
      )
      SELECT
        f.item_id,
        f.connected_realm_id,
        f.current_price,
        f.current_demand,
        f.price_pct_diff,
        f.demand_pct_diff,
        f.price_z,
        f.demand_z,
        f.hotness_score,
        f.confidence,
        f.listing_count,
        f.total_quantity,
        f.baseline_window_days,
        f.updated_at,
        f.sell_suitability_score,
        i.name as item_name,
        i.quality as item_quality,
        i.level as item_level,
        i.item_class,
        i.item_subclass,
        m.icon_url,
        ri.name as realm_name,
        (SELECT COUNT(DISTINCT connected_realm_id)
         FROM item_realm_aggregates WHERE item_id = f.item_id AND region = f.region) as total_realm_count,
        (SELECT COUNT(DISTINCT connected_realm_id)
         FROM item_realm_features_latest WHERE item_id = f.item_id AND region = f.region) as hot_realm_count
      FROM item_realm_features_latest f
      LEFT JOIN items i ON f.item_id = i.id
      LEFT JOIN item_media m ON f.item_id = m.item_id
      LEFT JOIN realm_info ri ON f.connected_realm_id = ri.connected_realm_id
      WHERE ${whereClause}
      ORDER BY ${sortCol} DESC
      LIMIT ${limit}
    `;
    }

    const rows = await sql.unsafe(query);

    // --- BATCH alternate realms in ONE query ---
    // Get top 5 hot alternates for all items at once, then group by item_id in JS
    const itemIds = rows.map((r: any) => r.item_id);
    const bestRealmMap = new Map<number, number>();
    rows.forEach((r: any) => bestRealmMap.set(r.item_id, r.connected_realm_id));

    let alternatesMap = new Map<number, any[]>();

    if (itemIds.length > 0) {
      const altRows = await sql`
        WITH ranked AS (
          SELECT
            f.item_id,
            f.connected_realm_id,
            f.price_z,
            f.demand_z,
            f.sell_suitability_score,
            f.current_price,
            f.confidence,
            f.total_quantity,
            ri.name as realm_name,
            ROW_NUMBER() OVER (PARTITION BY f.item_id ORDER BY f.sell_suitability_score DESC) as rn
          FROM item_realm_features_latest f
          LEFT JOIN (
            SELECT connected_realm_id, MIN(name) as name
            FROM realms
            GROUP BY connected_realm_id
          ) ri ON f.connected_realm_id = ri.connected_realm_id
          WHERE f.region = ${region}
            AND f.item_id = ANY(${itemIds})
        )
        SELECT * FROM ranked WHERE rn <= 6
      `;

      // Group by item_id, exclude the best realm for each item
      for (const alt of altRows) {
        const itemId = alt.item_id;
        const bestRealmId = bestRealmMap.get(itemId);
        if (alt.connected_realm_id === bestRealmId) continue;

        if (!alternatesMap.has(itemId)) alternatesMap.set(itemId, []);
        const list = alternatesMap.get(itemId)!;
        if (list.length < 5) {
          list.push({
            connected_realm_id: alt.connected_realm_id,
            realm_name: alt.realm_name,
            price_z: alt.price_z,
            demand_z: alt.demand_z,
            sell_suitability_score: alt.sell_suitability_score,
            current_price: alt.current_price,
            confidence: alt.confidence,
            total_quantity: Number(alt.total_quantity),
          });
        }
      }
    }

    // --- Build response (pure JS mapping, no DB calls) ---
    const items = rows.map((row: any) => ({
      item: {
        item_id: row.item_id,
        name: row.item_name,
        quality: row.item_quality,
        icon_url: row.icon_url,
        level: row.item_level,
        item_class: row.item_class,
        item_subclass: row.item_subclass,
      },
      best_realm: {
        connected_realm_id: row.connected_realm_id,
        realm_name: row.realm_name,
        price_z: row.price_z,
        demand_z: row.demand_z,
        sell_suitability_score: row.sell_suitability_score,
        current_price: row.current_price,
        confidence: row.confidence,
        total_quantity: Number(row.total_quantity),
      },
      alternate_realms: alternatesMap.get(row.item_id) ?? [],
      total_realm_count: Number(row.total_realm_count ?? 0),
      hot_realm_count: Number(row.hot_realm_count ?? 0),
      current_price: Number(row.current_price),
      current_demand: Number(row.current_demand),
      price_pct_diff: Number(row.price_pct_diff),
      demand_pct_diff: Number(row.demand_pct_diff),
      price_z: Number(row.price_z),
      demand_z: Number(row.demand_z),
      sizzle_score: Number(row.hotness_score),
      confidence: Number(row.confidence),
      listing_count: Number(row.listing_count),
      total_quantity: Number(row.total_quantity),
      baseline_window_days: row.baseline_window_days ?? 14,
      updated_at: row.updated_at,
    }));

    const responseBody = {
      items,
      total_count: items.length,
      mode,
      region,
      baseline_window_days: parseInt(process.env.BASELINE_WINDOW_DAYS || '14'),
      generated_at: new Date().toISOString(),
    };

    // --- Cache the response ---
    await cacheSet(cacheKey, responseBody, CACHE_TTL);

    return NextResponse.json(responseBody, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Hot API error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
