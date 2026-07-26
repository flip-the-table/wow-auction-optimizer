import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cachePing } from '@/lib/cache';

export const runtime = 'nodejs'; // Node.js runtime required for postgres driver
// Without this, Next.js prerenders this handler at BUILD time and serves the
// same frozen JSON forever (no `request` usage = static route).
export const dynamic = 'force-dynamic';

export async function GET() {
  const sql = getDb();

  let dbOk = false;
  let lastIngest: string | null = null;
  let lastCompute: string | null = null;
  let realmCount: number | null = null;
  let itemCount: number | null = null;

  try {
    await sql`SELECT 1`;
    dbOk = true;

    const ingestResult = await sql`
      SELECT MAX(fetched_at) as last_ingest
      FROM snapshots WHERE status = 'success'
    `;
    lastIngest = ingestResult[0]?.last_ingest ?? null;

    const computeResult = await sql`
      SELECT MAX(updated_at) as last_compute
      FROM item_realm_features_latest
    `;
    lastCompute = computeResult[0]?.last_compute ?? null;

    const realmResult = await sql`
      SELECT COUNT(DISTINCT connected_realm_id) as cnt FROM realms
    `;
    realmCount = realmResult[0]?.cnt != null ? Number(realmResult[0].cnt) : null;

    const itemResult = await sql`
      SELECT COUNT(DISTINCT item_id) as cnt FROM item_realm_features_latest
    `;
    itemCount = itemResult[0]?.cnt != null ? Number(itemResult[0].cnt) : null;
  } catch (e) {
    console.error('Health check DB error:', e);
  }

  const redisOk = await cachePing();

  // Implied-material valuation pipeline health (null until schema/data exist)
  let lumber: any = null;
  try {
    const [row] = await sql`
      SELECT
        (SELECT source_version FROM decor_recipe_sources s
          WHERE EXISTS (SELECT 1 FROM decor_recipes r WHERE r.source_id = s.id AND r.active)
          ORDER BY s.created_at DESC LIMIT 1) as active_source_version,
        (SELECT formula_version FROM lumber_formula_versions
          ORDER BY created_at DESC LIMIT 1) as active_formula_version,
        (SELECT MAX(created_at) FROM decor_recipe_sources) as last_decor_recipe_load_at,
        (SELECT MAX(computed_at) FROM material_value_summaries) as last_material_value_compute_at,
        (SELECT COUNT(*) FROM decor_recipe_valuations
          WHERE eligibility_status = 'ELIGIBLE') as eligible_recipe_count,
        (SELECT COUNT(*) FROM decor_recipe_valuations
          WHERE eligibility_status = 'EXCLUDED') as excluded_recipe_count,
        (SELECT COUNT(*) FROM decor_recipe_valuations
          WHERE exclusion_reasons::text LIKE '%STALE%') as stale_recipe_count,
        (SELECT COUNT(*) FROM decor_recipe_valuations
          WHERE exclusion_reasons::text LIKE '%MISSING_REAGENT_PRICE%') as missing_price_count
    `;
    lumber = {
      feature_enabled: process.env.LUMBER_FEATURE_ENABLED === 'true',
      active_decor_recipe_source_version: row?.active_source_version ?? null,
      active_formula_version: row?.active_formula_version ?? null,
      last_decor_recipe_load_at: row?.last_decor_recipe_load_at ?? null,
      last_material_value_compute_at: row?.last_material_value_compute_at ?? null,
      eligible_recipe_count: Number(row?.eligible_recipe_count ?? 0),
      excluded_recipe_count: Number(row?.excluded_recipe_count ?? 0),
      stale_recipe_count: Number(row?.stale_recipe_count ?? 0),
      missing_price_count: Number(row?.missing_price_count ?? 0),
    };
  } catch {
    lumber = { feature_enabled: process.env.LUMBER_FEATURE_ENABLED === 'true', schema_present: false };
  }

  return NextResponse.json(
    {
      status: dbOk ? 'ok' : 'degraded',
      db_connected: dbOk,
      redis_connected: redisOk,
      last_ingest_at: lastIngest,
      last_compute_at: lastCompute,
      realm_count: realmCount,
      item_count: itemCount,
      lumber,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
