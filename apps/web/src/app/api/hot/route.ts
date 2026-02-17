import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const sql = getDb();
  const region = process.env.REGION || 'us';
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get('mode') || 'both';
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50'), 1), 500);
  const minConfidence = parseFloat(searchParams.get('minConfidence') || '0');
  const realm = searchParams.get('realm') ? parseInt(searchParams.get('realm')!) : null;
  const search = searchParams.get('search') || null;

  const sortCol = 'f.hotness_score';

  // Build the query dynamically
  let whereConditions = [`f.region = '${region}'`];
  whereConditions.push(`i.item_subclass = 'Decor'`);
  if (minConfidence > 0) whereConditions.push(`f.confidence >= ${minConfidence}`);
  if (realm !== null) whereConditions.push(`f.connected_realm_id = ${realm}`);
  if (search) whereConditions.push(`i.name ILIKE '%${search.replace(/'/g, "''")}%'`);

  const whereClause = whereConditions.join(' AND ');

  let query: string;

  if (realm === null) {
    // Region-wide: best realm per item
    query = `
      WITH best_per_item AS (
        SELECT
          f.item_id,
          MAX(${sortCol}) as best_score
        FROM item_realm_features_latest f
        WHERE f.region = '${region}'
        GROUP BY f.item_id
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
        m.icon_url
      FROM item_realm_features_latest f
      JOIN best_per_item b ON f.item_id = b.item_id AND ${sortCol} = b.best_score
      LEFT JOIN items i ON f.item_id = i.id
      LEFT JOIN item_media m ON f.item_id = m.item_id
      WHERE ${whereClause}
      ORDER BY ${sortCol} DESC
      LIMIT ${limit}
    `;
  } else {
    query = `
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
        m.icon_url
      FROM item_realm_features_latest f
      LEFT JOIN items i ON f.item_id = i.id
      LEFT JOIN item_media m ON f.item_id = m.item_id
      WHERE ${whereClause}
      ORDER BY ${sortCol} DESC
      LIMIT ${limit}
    `;
  }

  // Use sql.unsafe() for dynamic queries (query is built with string interpolation)
  const rows = await sql.unsafe(query);

  // For each item, get realm name and alternates
  const items = await Promise.all(
    rows.map(async (row: any) => {
      // Get realm name
      const realmRows = await sql`
        SELECT name FROM realms
        WHERE connected_realm_id = ${row.connected_realm_id}
        LIMIT 1
      `;
      const realmName = realmRows[0]?.name ?? null;

      // Get alternate realms (top 5)
      const altRows = await sql`
        SELECT
          f.connected_realm_id,
          f.price_z,
          f.demand_z,
          f.sell_suitability_score,
          f.current_price,
          f.confidence,
          f.total_quantity,
          r.name as realm_name
        FROM item_realm_features_latest f
        LEFT JOIN (
          SELECT DISTINCT ON (connected_realm_id) connected_realm_id, name
          FROM realms
          ORDER BY connected_realm_id, name ASC
        ) r ON f.connected_realm_id = r.connected_realm_id
        WHERE f.region = ${region}
          AND f.item_id = ${row.item_id}
          AND f.connected_realm_id != ${row.connected_realm_id}
        ORDER BY f.sell_suitability_score DESC
        LIMIT 5
      `;

      return {
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
          realm_name: realmName,
          price_z: row.price_z,
          demand_z: row.demand_z,
          sell_suitability_score: row.sell_suitability_score,
          current_price: row.current_price,
          confidence: row.confidence,
          total_quantity: Number(row.total_quantity),
        },
        alternate_realms: altRows.map((alt: any) => ({
          connected_realm_id: alt.connected_realm_id,
          realm_name: alt.realm_name,
          price_z: alt.price_z,
          demand_z: alt.demand_z,
          sell_suitability_score: alt.sell_suitability_score,
          current_price: alt.current_price,
          confidence: alt.confidence,
          total_quantity: Number(alt.total_quantity),
        })),
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
      };
    })
  );

  return NextResponse.json({
    items,
    total_count: items.length,
    mode,
    region,
    baseline_window_days: parseInt(process.env.BASELINE_WINDOW_DAYS || '14'),
    generated_at: new Date().toISOString(),
  });
}
