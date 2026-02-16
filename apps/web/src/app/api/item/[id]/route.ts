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

  // Current stats from aggregates (no per-snapshot history anymore)
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
    median_buyout: row.median_buyout,
    demand_proxy_smoothed: row.demand_proxy_smoothed,
    listing_count: row.listing_count,
    total_quantity: row.total_quantity,
    ewma_price: row.ewma_price,
    ewma_demand: row.ewma_demand,
    snapshot_count: row.snapshot_count,
  }));

  return NextResponse.json({
    item: itemInfo,
    realm_leaderboard: realmLeaderboard,
    time_series: timeSeries,
    baseline_window_days: days,
    generated_at: new Date().toISOString(),
  });
}
