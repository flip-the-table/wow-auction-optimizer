import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';
import { mapValuationRow } from '@/lib/valuation-mapper';

export const runtime = 'nodejs';

const CACHE_TTL = 300;

// Sort whitelist -> SQL column (never interpolate user input directly)
const SORTS: Record<string, string> = {
  value_per_material: 'v.implied_value_per_material',
  expected_daily_contribution: 'v.expected_daily_contribution',
  model_quality: 'v.model_confidence_score',
  listing_liquidity: 'v.liquidity_score',
};

export async function GET(request: NextRequest) {
  try {
    if (process.env.LUMBER_FEATURE_ENABLED !== 'true') {
      return NextResponse.json({ status: 'disabled', rows: [], total_returned: 0, include_excluded: false }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);
    const materialKey = (searchParams.get('material') || '').trim();
    const realmRaw = parseInt(searchParams.get('realm') ?? '', 10);
    const realm = Number.isFinite(realmRaw) ? realmRaw : null;
    const sortKey = searchParams.get('sort') || 'value_per_material';
    const limitRaw = parseInt(searchParams.get('limit') ?? '50', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
    const offsetRaw = parseInt(searchParams.get('offset') ?? '0', 10);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);
    const includeExcluded = searchParams.get('include_excluded') === '1';
    const fvParam = (searchParams.get('formula_version') || '').trim() || null;

    if (!/^[a-z0-9_]{2,64}$/.test(materialKey) || realm === null) {
      return NextResponse.json({ error: 'material and realm parameters required' }, { status: 400 });
    }
    const sortCol = SORTS[sortKey];
    if (!sortCol) {
      return NextResponse.json({ error: `invalid sort; supported: ${Object.keys(SORTS).join(', ')}` }, { status: 400 });
    }

    const cacheKey = `decorops:${region}:${realm}:${materialKey}:${sortKey}:${limit}:${offset}:${includeExcluded}:${fvParam ?? 'latest'}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();

    let material: any;
    try {
      [material] = await sql`
        SELECT id FROM constrained_materials WHERE material_key = ${materialKey}
      `;
    } catch (e: any) {
      if (e?.code === '42P01' || /does not exist/.test(e?.message ?? '')) {
        return NextResponse.json({ status: 'no_mapping', rows: [], total_returned: 0, include_excluded: includeExcluded }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      throw e;
    }
    if (!material) {
      return NextResponse.json({ status: 'unknown_material', rows: [], total_returned: 0, include_excluded: includeExcluded }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Resolve formula version: pinned or the newest computed for this scope
    let fv = fvParam;
    if (!fv) {
      const [latest] = await sql`
        SELECT formula_version FROM material_value_summaries
        WHERE region = ${region} AND connected_realm_id = ${realm}
          AND constrained_material_id = ${material.id}
        ORDER BY computed_at DESC LIMIT 1
      `;
      fv = latest?.formula_version ?? null;
    }
    if (!fv) {
      return NextResponse.json({ status: 'no_data', rows: [], total_returned: 0, include_excluded: includeExcluded }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const eligibilityFilter = includeExcluded ? sql`` : sql`AND v.eligibility_status = 'ELIGIBLE'`;
    const rows = await sql`
      SELECT v.*, r.recipe_name, r.external_recipe_key, r.crafting_system,
             r.verification_status, r.decor_item_id,
             src.source_version,
             i.name as item_name, i.quality as item_quality, m.icon_url,
             ri.name as realm_name
      FROM decor_recipe_valuations v
      JOIN decor_recipes r ON r.id = v.decor_recipe_id
      LEFT JOIN decor_recipe_sources src ON src.id = r.source_id
      LEFT JOIN items i ON i.id = r.decor_item_id
      LEFT JOIN item_media m ON m.item_id = r.decor_item_id
      LEFT JOIN (
        SELECT connected_realm_id, MIN(name) as name FROM realms GROUP BY connected_realm_id
      ) ri ON ri.connected_realm_id = v.connected_realm_id
      WHERE v.region = ${region} AND v.connected_realm_id = ${realm}
        AND v.constrained_material_id = ${material.id}
        AND v.formula_version = ${fv}
        ${eligibilityFilter}
      ORDER BY ${sql.unsafe(sortCol)} DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;

    const body = {
      status: rows.length > 0 ? 'ok' : 'no_data',
      rows: rows.map(mapValuationRow),
      total_returned: rows.length,
      include_excluded: includeExcluded,
      formula_version: fv,
      computed_at: rows[0]?.computed_at ?? null,
    };

    await cacheSet(cacheKey, body, CACHE_TTL);
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Decor opportunities API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
