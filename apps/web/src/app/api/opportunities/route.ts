import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 1800;

const SORTS: Record<string, string> = {
  opportunity: 'o.opportunity_score DESC NULLS LAST',
  cheapness: 'o.price_percentile_30d ASC NULLS LAST',
  demand_momentum: 'o.demand_slope_7d DESC NULLS LAST',
  supply_squeeze: 'o.supply_slope_7d ASC NULLS LAST',
  sell_zone: 'o.price_percentile_30d DESC NULLS LAST',
};

function intParam(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);
    const realmRaw = intParam(searchParams.get('realm'), NaN);
    const realm = Number.isFinite(realmRaw) ? realmRaw : null;
    const sortKey = searchParams.get('sort') || 'opportunity';
    const limit = Math.min(Math.max(intParam(searchParams.get('limit'), 50), 1), 100);
    const sortSql = SORTS[sortKey];
    if (!sortSql) {
      return NextResponse.json(
        { error: `invalid sort; supported: ${Object.keys(SORTS).join(', ')}` },
        { status: 400 }
      );
    }

    const cacheKey = `opps:${region}:${realm ?? 'all'}:${sortKey}:${limit}`;
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
    const realmFilter = realm !== null ? sql`AND o.connected_realm_id = ${realm}` : sql``;

    let rows: any[];
    try {
      rows = await sql`
        SELECT o.*, i.name AS item_name, i.quality AS item_quality, m.icon_url,
               ri.name AS realm_name,
               f.removals_per_day,
               f.tl_short, f.tl_medium, f.tl_long, f.tl_very_long
        FROM item_opportunities o
        JOIN items i ON i.id = o.item_id
        LEFT JOIN item_media m ON m.item_id = o.item_id
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
        ) ri ON ri.connected_realm_id = o.connected_realm_id
        LEFT JOIN item_realm_features_latest f
          ON f.region = o.region AND f.connected_realm_id = o.connected_realm_id
         AND f.item_id = o.item_id
        WHERE o.region = ${region}
          ${realmFilter}
        ORDER BY ${sql.unsafe(SORTS[sortKey])}
        LIMIT ${limit}
      `;
    } catch (e: any) {
      if (e?.code === '42P01' || /does not exist/.test(e?.message ?? '')) {
        return NextResponse.json({ status: 'no_data', rows: [] }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      throw e;
    }

    const body = {
      status: rows.length > 0 ? 'ok' : 'no_data',
      rows: rows.map((r: any) => ({
        item: {
          item_id: r.item_id,
          name: r.item_name,
          quality: r.item_quality,
          icon_url: r.icon_url,
        },
        connected_realm_id: r.connected_realm_id,
        realm_name: r.realm_name,
        current_price: r.current_price != null ? Number(r.current_price) : null,
        listing_count: r.listing_count != null ? Number(r.listing_count) : null,
        history_days: Number(r.history_days ?? 0),
        price_percentile_30d: r.price_percentile_30d != null ? Number(r.price_percentile_30d) : null,
        price_slope_7d: r.price_slope_7d != null ? Number(r.price_slope_7d) : null,
        demand_slope_7d: r.demand_slope_7d != null ? Number(r.demand_slope_7d) : null,
        supply_slope_7d: r.supply_slope_7d != null ? Number(r.supply_slope_7d) : null,
        best_sell_day: r.best_sell_day != null ? Number(r.best_sell_day) : null,
        best_day_uplift: r.best_day_uplift != null ? Number(r.best_day_uplift) : null,
        opportunity_score: r.opportunity_score != null ? Number(r.opportunity_score) : null,
        removals_per_day: r.removals_per_day != null ? Number(r.removals_per_day) : null,
        listing_age: r.tl_very_long != null ? {
          short: Number(r.tl_short ?? 0),
          medium: Number(r.tl_medium ?? 0),
          long: Number(r.tl_long ?? 0),
          very_long: Number(r.tl_very_long ?? 0),
        } : null,
        computed_at: r.computed_at,
      })),
      total_returned: rows.length,
      generated_at: new Date().toISOString(),
    };

    if (body.status === 'ok') await cacheSet(cacheKey, body, CACHE_TTL);
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Opportunities API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
