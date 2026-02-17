import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 300; // 5 minutes

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const region = process.env.REGION || 'us';
    const itemId = parseInt(params.id, 10);
    const { searchParams } = new URL(request.url);

    const realm = searchParams.get('realm') ? parseInt(searchParams.get('realm')!) : null;
    const days = Math.min(Math.max(parseInt(searchParams.get('days') || '14'), 1), 90);

    // --- Cache check ---
    const cacheKey = `item:${itemId}:${region}:${realm ?? 'all'}:${days}`;
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

    // --- Run independent queries in PARALLEL ---
    const [itemRows, mediaRows, lbRows, tsRows, dailyTimeSeries, allRealmStats] = await Promise.all([
      // 1. Item metadata
      sql`SELECT id, name, quality, level, item_class, item_subclass FROM items WHERE id = ${itemId}`,

      // 2. Item media
      sql`SELECT icon_url FROM item_media WHERE item_id = ${itemId}`,

      // 3. Realm leaderboard (UNION of featured + aggregates-only)
      sql`
      WITH featured AS (
        SELECT
          f.connected_realm_id,
          f.price_z,
          f.demand_z,
          f.sell_suitability_score,
          COALESCE(a.median_buyout, f.current_price) as current_price,
          f.confidence,
          COALESCE(a.total_quantity, f.total_quantity) as total_quantity,
          r.name as realm_name,
          r.all_names as connected_realm_names,
          r.realm_count
        FROM item_realm_features_latest f
        LEFT JOIN item_realm_aggregates a
          ON f.item_id = a.item_id
          AND f.connected_realm_id = a.connected_realm_id
          AND f.region = a.region
        LEFT JOIN (
          SELECT connected_realm_id,
                 MIN(name) as name,
                 string_agg(name, ', ' ORDER BY name) as all_names,
                 COUNT(*) as realm_count
          FROM realms
          GROUP BY connected_realm_id
        ) r ON f.connected_realm_id = r.connected_realm_id
        WHERE f.region = ${region}
          AND f.item_id = ${itemId}
      ),
      aggregates_only AS (
        SELECT
          a.connected_realm_id,
          NULL::float as price_z,
          NULL::float as demand_z,
          NULL::float as sell_suitability_score,
          a.median_buyout as current_price,
          NULL::float as confidence,
          a.total_quantity,
          r.name as realm_name,
          r.all_names as connected_realm_names,
          r.realm_count
        FROM item_realm_aggregates a
        LEFT JOIN (
          SELECT connected_realm_id,
                 MIN(name) as name,
                 string_agg(name, ', ' ORDER BY name) as all_names,
                 COUNT(*) as realm_count
          FROM realms
          GROUP BY connected_realm_id
        ) r ON a.connected_realm_id = r.connected_realm_id
        WHERE a.region = ${region}
          AND a.item_id = ${itemId}
          AND a.connected_realm_id NOT IN (SELECT connected_realm_id FROM featured)
      )
      SELECT * FROM (
        SELECT *, true as has_features FROM featured
        UNION ALL
        SELECT *, false as has_features FROM aggregates_only
      ) combined
      ORDER BY COALESCE(sell_suitability_score, -999) DESC, current_price DESC
    `,

      // 4. Time-series (aggregates)
      realm !== null
        ? sql`
        SELECT
          a.updated_at as timestamp,
          a.median_buyout,
          a.demand_proxy_smoothed,
          a.listing_count,
          a.total_quantity,
          a.ewma_price,
          a.ewma_demand,
          a.snapshot_count
        FROM item_realm_aggregates a
        WHERE a.item_id = ${itemId}
          AND a.region = ${region}
          AND a.connected_realm_id = ${realm}
      `
        : sql`
        SELECT
          a.updated_at as timestamp,
          a.median_buyout,
          a.demand_proxy_smoothed,
          a.listing_count,
          a.total_quantity,
          a.ewma_price,
          a.ewma_demand,
          a.snapshot_count,
          a.connected_realm_id
        FROM item_realm_aggregates a
        WHERE a.item_id = ${itemId}
          AND a.region = ${region}
        ORDER BY a.median_buyout DESC
        LIMIT 50
      `,

      // 5. Daily time-series
      (async () => {
        try {
          let dailyRows;
          if (realm !== null) {
            dailyRows = await sql`
            SELECT d.date, d.median_price, d.demand_proxy, d.listing_count, d.total_quantity
            FROM item_realm_daily d
            WHERE d.item_id = ${itemId} AND d.region = ${region} AND d.connected_realm_id = ${realm}
            ORDER BY d.date ASC LIMIT ${days}
          `;
          } else {
            dailyRows = await sql`
            SELECT
              d.date,
              AVG(d.median_price)::bigint as median_price,
              AVG(d.demand_proxy) as demand_proxy,
              SUM(d.listing_count) as listing_count,
              SUM(d.total_quantity) as total_quantity
            FROM item_realm_daily d
            WHERE d.item_id = ${itemId} AND d.region = ${region}
            GROUP BY d.date ORDER BY d.date ASC LIMIT ${days}
          `;
          }
          return dailyRows.map((row: any) => ({
            date: row.date,
            median_price: Number(row.median_price),
            demand_proxy: Number(row.demand_proxy),
            listing_count: Number(row.listing_count),
            total_quantity: Number(row.total_quantity),
          }));
        } catch {
          return []; // Table may not exist
        }
      })(),

      // 6. All-realm aggregate stats
      sql`
      SELECT
        COUNT(*)::int as realm_count,
        AVG(a.median_buyout)::bigint as mean_price,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.median_buyout)::bigint as median_price,
        SUM(a.total_quantity)::int as total_available,
        MIN(a.median_buyout)::bigint as min_price,
        MAX(a.median_buyout)::bigint as max_price
      FROM item_realm_aggregates a
      WHERE a.item_id = ${itemId} AND a.region = ${region}
    `,
    ]);

    // --- Process results ---
    const item = itemRows[0] ?? null;
    const media = mediaRows[0] ?? null;

    const itemInfo = {
      item_id: itemId,
      name: item?.name ?? null,
      quality: item?.quality ?? null,
      icon_url: media?.icon_url ?? null,
      level: item?.level ?? null,
      item_class: item?.item_class ?? null,
      item_subclass: item?.item_subclass ?? null,
    };

    const realmLeaderboard = lbRows.map((r: any) => ({
      connected_realm_id: r.connected_realm_id,
      realm_name: r.realm_name,
      connected_realm_names: r.connected_realm_names,
      realm_count: Number(r.realm_count ?? 1),
      price_z: r.price_z != null ? Number(r.price_z) : null,
      demand_z: r.demand_z != null ? Number(r.demand_z) : null,
      sell_suitability_score: r.sell_suitability_score != null ? Number(r.sell_suitability_score) : null,
      current_price: Number(r.current_price),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      total_quantity: Number(r.total_quantity),
      has_features: r.has_features ?? false,
    }));

    const timeSeries = tsRows.map((row: any) => ({
      timestamp: row.timestamp,
      median_buyout: Number(row.median_buyout),
      demand_proxy_smoothed: Number(row.demand_proxy_smoothed),
      listing_count: Number(row.listing_count),
      total_quantity: Number(row.total_quantity),
      ewma_price: Number(row.ewma_price),
      ewma_demand: Number(row.ewma_demand),
      snapshot_count: Number(row.snapshot_count),
      connected_realm_id: row.connected_realm_id ? Number(row.connected_realm_id) : undefined,
    }));

    // Selected realm stats (only if realm filter is on)
    let selectedRealmStats = null;
    if (realm !== null && tsRows.length > 0) {
      // We already have the aggregates data from tsRows, derive stats from leaderboard
      const realmEntry = realmLeaderboard.find(r => r.connected_realm_id === realm);
      if (realmEntry) {
        selectedRealmStats = {
          current_price: realmEntry.current_price,
          available: realmEntry.total_quantity,
          listing_count: 0,
          mean_price: realmEntry.current_price,
          ewma_price: realmEntry.current_price,
        };
      }
    }

    const baseStats = {
      all_realms: allRealmStats.length > 0 ? {
        realm_count: Number(allRealmStats[0].realm_count),
        mean_price: Number(allRealmStats[0].mean_price),
        median_price: Number(allRealmStats[0].median_price),
        total_available: Number(allRealmStats[0].total_available),
        min_price: Number(allRealmStats[0].min_price),
        max_price: Number(allRealmStats[0].max_price),
      } : null,
      selected_realm: selectedRealmStats,
    };

    const responseBody = {
      item: itemInfo,
      realm_leaderboard: realmLeaderboard,
      time_series: timeSeries,
      daily_time_series: dailyTimeSeries,
      base_stats: baseStats,
      baseline_window_days: days,
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
    console.error('Item API error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
