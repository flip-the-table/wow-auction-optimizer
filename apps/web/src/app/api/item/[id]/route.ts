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

    // Time series
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let tsRows;
    if (realm !== null) {
        tsRows = await sql`
      SELECT
        s.fetched_at as timestamp,
        m.median_buyout,
        m.demand_proxy_smoothed,
        m.listing_count,
        m.total_quantity
      FROM item_realm_snapshot_metrics m
      JOIN snapshots s ON m.snapshot_id = s.id
      WHERE m.item_id = ${itemId}
        AND m.connected_realm_id = ${realm}
        AND s.fetched_at >= ${cutoff}::timestamptz
      ORDER BY s.fetched_at ASC
    `;
    } else {
        tsRows = await sql`
      SELECT
        s.fetched_at as timestamp,
        m.median_buyout,
        m.demand_proxy_smoothed,
        m.listing_count,
        m.total_quantity
      FROM item_realm_snapshot_metrics m
      JOIN snapshots s ON m.snapshot_id = s.id
      WHERE m.item_id = ${itemId}
        AND s.fetched_at >= ${cutoff}::timestamptz
      ORDER BY s.fetched_at ASC
    `;
    }

    const timeSeries = tsRows.map((row: any) => ({
        timestamp: row.timestamp,
        median_buyout: row.median_buyout,
        demand_proxy_smoothed: row.demand_proxy_smoothed,
        listing_count: row.listing_count,
        total_quantity: row.total_quantity,
    }));

    return NextResponse.json({
        item: itemInfo,
        realm_leaderboard: realmLeaderboard,
        time_series: timeSeries,
        baseline_window_days: days,
        generated_at: new Date().toISOString(),
    });
}
