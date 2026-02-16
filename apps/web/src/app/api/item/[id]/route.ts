import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'edge';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const sql = getDb();
  const region = process.env.REGION || 'us';
  const itemId = parseInt(params.id, 10);
  const { searchParams } = new URL(request.url);

  const realm = searchParams.get('realm') ? parseInt(searchParams.get('realm')!) : null;
  const days = Math.min(Math.max(parseInt(searchParams.get('days') || '14'), 1), 90);

  // Item metadata
  const itemRows = await sql`
    SELECT id, name, quality, level, item_class, item_subclass
    FROM items WHERE id = ${itemId}
  `;
  const item = itemRows[0] ?? null;

  // Item media
  const mediaRows = await sql`
    SELECT icon_url FROM item_media WHERE item_id = ${itemId}
  `;
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

  // Realm leaderboard (top 20 realms by sell suitability)
  const lbRows = await sql`
    SELECT
      f.connected_realm_id,
      f.price_z,
      f.demand_z,
      f.sell_suitability_score,
      f.current_price,
      f.confidence,
      r.name as realm_name
    FROM item_realm_features_latest f
    LEFT JOIN (
      SELECT DISTINCT ON (connected_realm_id) connected_realm_id, name
      FROM realms
      ORDER BY connected_realm_id, name ASC
    ) r ON f.connected_realm_id = r.connected_realm_id
    WHERE f.region = ${region}
      AND f.item_id = ${itemId}
    ORDER BY f.sell_suitability_score DESC
    LIMIT 20
  `;

  const realmLeaderboard = lbRows.map((r: any) => ({
    connected_realm_id: r.connected_realm_id,
    realm_name: r.realm_name,
    price_z: r.price_z,
    demand_z: r.demand_z,
    sell_suitability_score: r.sell_suitability_score,
    current_price: r.current_price,
    confidence: r.confidence,
  }));

  // Current stats from aggregates (cross-realm comparison)
  let tsRows;
  if (realm !== null) {
    tsRows = await sql`
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
    `;
  } else {
    tsRows = await sql`
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
    `;
  }

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

  // Daily time-series from item_realm_daily (for trend charts)
  // Wrapped in try-catch because table may not exist yet (created on first ingest)
  let dailyTimeSeries: any[] = [];
  try {
    let dailyRows;
    if (realm !== null) {
      dailyRows = await sql`
        SELECT
          d.date,
          d.median_price,
          d.demand_proxy,
          d.listing_count,
          d.total_quantity
        FROM item_realm_daily d
        WHERE d.item_id = ${itemId}
          AND d.region = ${region}
          AND d.connected_realm_id = ${realm}
        ORDER BY d.date ASC
        LIMIT ${days}
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
        WHERE d.item_id = ${itemId}
          AND d.region = ${region}
        GROUP BY d.date
        ORDER BY d.date ASC
        LIMIT ${days}
      `;
    }

    dailyTimeSeries = dailyRows.map((row: any) => ({
      date: row.date,
      median_price: Number(row.median_price),
      demand_proxy: Number(row.demand_proxy),
      listing_count: Number(row.listing_count),
      total_quantity: Number(row.total_quantity),
    }));
  } catch {
    // Table may not exist yet — return empty array
  }
  // Base stats (region-wide and per-realm)
  const allRealmStats = await sql`
    SELECT
      COUNT(*)::int as realm_count,
      AVG(a.median_buyout)::bigint as mean_price,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.median_buyout)::bigint as median_price,
      SUM(a.total_quantity)::int as total_available,
      MIN(a.median_buyout)::bigint as min_price,
      MAX(a.median_buyout)::bigint as max_price
    FROM item_realm_aggregates a
    WHERE a.item_id = ${itemId}
      AND a.region = ${region}
  `;

  let selectedRealmStats = null;
  if (realm !== null) {
    const srRows = await sql`
      SELECT
        a.median_buyout as current_price,
        a.total_quantity as available,
        a.listing_count,
        a.price_mean,
        a.ewma_price
      FROM item_realm_aggregates a
      WHERE a.item_id = ${itemId}
        AND a.region = ${region}
        AND a.connected_realm_id = ${realm}
    `;
    if (srRows.length > 0) {
      const sr = srRows[0];
      selectedRealmStats = {
        current_price: Number(sr.current_price),
        available: Number(sr.available),
        listing_count: Number(sr.listing_count),
        mean_price: Math.round(Number(sr.price_mean)),
        ewma_price: Math.round(Number(sr.ewma_price)),
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

  return NextResponse.json({
    item: itemInfo,
    realm_leaderboard: realmLeaderboard,
    time_series: timeSeries,
    daily_time_series: dailyTimeSeries,
    base_stats: baseStats,
    baseline_window_days: days,
    generated_at: new Date().toISOString(),
  });
}
