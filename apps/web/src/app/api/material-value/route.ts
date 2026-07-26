import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';
import { mapValuationRow } from '@/lib/valuation-mapper';

export const runtime = 'nodejs';

const CACHE_TTL = 300;

// Field-group data classifications (Phase 2 domain model), returned so the UI
// can label observed vs modeled values without hardcoding.
const CLASSIFICATIONS: Record<string, string> = {
  listing_median: 'OBSERVED_LISTING',
  listing_min: 'OBSERVED_LISTING',
  listing_count: 'OBSERVED_LISTING',
  listed_quantity: 'OBSERVED_LISTING',
  churn_rate: 'DERIVED',
  estimated_market_units_per_day: 'DERIVED',
  freshness_score: 'DERIVED',
  liquidity_score: 'DERIVED',
  input_quality_score: 'DERIVED',
  model_quality: 'DERIVED',
  estimated_realized_unit_price: 'MODELED',
  expected_deposit_loss: 'MODELED',
  seller_capture_factor: 'MODELED',
  implied_value_per_material: 'MODELED',
  reference_implied_value: 'MODELED',
  best_conversion_value: 'MODELED',
  conservative_implied_value: 'MODELED',
  expected_daily_contribution: 'MODELED',
  recipe_mapping: 'CURATED_SOURCE',
};

const REFRESH_HOURS_UTC = [2, 10, 18];

function nextScheduledRefresh(): string {
  const now = new Date();
  const next = new Date(now);
  const nextHour = REFRESH_HOURS_UTC.find((h) => h > now.getUTCHours());
  if (nextHour !== undefined) next.setUTCHours(nextHour, 0, 0, 0);
  else {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(REFRESH_HOURS_UTC[0], 0, 0, 0);
  }
  return next.toISOString();
}

function isMissingTable(e: any): boolean {
  return e?.code === '42P01' || /does not exist/.test(e?.message ?? '');
}

export async function GET(request: NextRequest) {
  try {
    if (process.env.LUMBER_FEATURE_ENABLED !== 'true') {
      return NextResponse.json({ status: 'disabled' }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);
    const materialKey = (searchParams.get('material') || '').trim();
    const realmRaw = parseInt(searchParams.get('realm') ?? '', 10);
    const realm = Number.isFinite(realmRaw) ? realmRaw : null;
    const fvParam = (searchParams.get('formula_version') || '').trim() || null;

    if (materialKey && !/^[a-z0-9_]{2,64}$/.test(materialKey)) {
      return NextResponse.json({ error: 'invalid material key' }, { status: 400 });
    }

    const sql = getDb();

    // --- No material param: list available materials (picker) ---
    if (!materialKey) {
      try {
        const materials = await sql`
          SELECT material_key, display_name, material_type, is_tradeable, is_account_bound
          FROM constrained_materials ORDER BY display_name
        `;
        if (materials.length === 0) {
          return NextResponse.json({ status: 'no_mapping', materials: [] }, {
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        return NextResponse.json(
          { status: 'ok', materials: materials.map((m: any) => ({ ...m })) },
          { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800' } }
        );
      } catch (e: any) {
        if (isMissingTable(e)) {
          return NextResponse.json({ status: 'no_mapping', materials: [] }, {
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        throw e;
      }
    }

    if (realm === null) {
      return NextResponse.json({ error: 'realm parameter required' }, { status: 400 });
    }

    const cacheKey = `matval:${region}:${realm}:${materialKey}:${fvParam ?? 'latest'}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
          'X-Cache': 'HIT',
        },
      });
    }

    let material: any;
    try {
      [material] = await sql`
        SELECT id, material_key, display_name, material_type, is_tradeable, is_account_bound
        FROM constrained_materials WHERE material_key = ${materialKey}
      `;
    } catch (e: any) {
      if (isMissingTable(e)) {
        return NextResponse.json({ status: 'no_mapping' }, { headers: { 'Cache-Control': 'no-store' } });
      }
      throw e;
    }
    if (!material) {
      return NextResponse.json({ status: 'unknown_material' }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    // Summary row: PK lookup (indexed); newest formula version unless pinned
    const fvFilter = fvParam ? sql`AND s.formula_version = ${fvParam}` : sql``;
    const [summary] = await sql`
      SELECT s.*, ri.name as realm_name
      FROM material_value_summaries s
      LEFT JOIN (
        SELECT connected_realm_id, MIN(name) as name FROM realms GROUP BY connected_realm_id
      ) ri ON ri.connected_realm_id = s.connected_realm_id
      WHERE s.region = ${region} AND s.connected_realm_id = ${realm}
        AND s.constrained_material_id = ${material.id}
        ${fvFilter}
      ORDER BY s.computed_at DESC
      LIMIT 1
    `;

    const materialInfo = {
      material_key: material.material_key,
      display_name: material.display_name,
      material_type: material.material_type,
      is_tradeable: material.is_tradeable,
      is_account_bound: material.is_account_bound,
    };

    if (!summary) {
      return NextResponse.json(
        {
          status: 'no_data', material: materialInfo, region,
          realm: { connected_realm_id: realm, name: null },
          next_scheduled_refresh: nextScheduledRefresh(),
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Assumptions from the persisted formula-version registry
    const [fvRow] = await sql`
      SELECT params FROM lumber_formula_versions
      WHERE formula_version = ${summary.formula_version}
    `;
    const assumptions = fvRow
      ? { formula_version: summary.formula_version, ...((fvRow.params as any) ?? {}) }
      : null;
    const maxAgeH = Number(assumptions?.max_input_age_hours ?? 12);
    const ageH = (Date.now() - new Date(summary.computed_at).getTime()) / 3.6e6;
    const isStale = ageH > maxAgeH;

    // Top conversions: indexed (region, realm, material, implied DESC)
    const top = await sql`
      SELECT v.*, r.recipe_name, r.external_recipe_key, r.crafting_system,
             r.verification_status, r.decor_item_id,
             src.source_version,
             i.name as item_name, i.quality as item_quality, m.icon_url
      FROM decor_recipe_valuations v
      JOIN decor_recipes r ON r.id = v.decor_recipe_id
      LEFT JOIN decor_recipe_sources src ON src.id = r.source_id
      LEFT JOIN items i ON i.id = r.decor_item_id
      LEFT JOIN item_media m ON m.item_id = r.decor_item_id
      WHERE v.region = ${region} AND v.connected_realm_id = ${realm}
        AND v.constrained_material_id = ${material.id}
        AND v.formula_version = ${summary.formula_version}
        AND v.eligibility_status = 'ELIGIBLE'
      ORDER BY v.implied_value_per_material DESC
      LIMIT 5
    `;

    const minEligible = Number(assumptions?.min_eligible_recipes ?? 3);
    const eligibleCount = Number(summary.eligible_recipe_count);
    const status = isStale
      ? 'stale'
      : eligibleCount === 0
        ? 'no_data'
        : eligibleCount < minEligible
          ? 'insufficient_data'
          : 'ok';

    const body = {
      status,
      material: materialInfo,
      realm: { connected_realm_id: realm, name: summary.realm_name },
      scope: 'realm' as const,
      region,
      // MODELED values — null when unavailable, never zero-as-placeholder
      reference_implied_value: summary.reference_implied_value != null ? Number(summary.reference_implied_value) : null,
      best_conversion_value: summary.best_conversion_value != null ? Number(summary.best_conversion_value) : null,
      conservative_implied_value: summary.conservative_implied_value != null ? Number(summary.conservative_implied_value) : null,
      eligible_recipe_count: eligibleCount,
      excluded_recipe_count: Number(summary.excluded_recipe_count),
      model_quality: summary.model_confidence_score != null ? Number(summary.model_confidence_score) : null,
      weighted_freshness_score: summary.weighted_freshness_score != null ? Number(summary.weighted_freshness_score) : null,
      weighted_liquidity_score: summary.weighted_liquidity_score != null ? Number(summary.weighted_liquidity_score) : null,
      computed_at: summary.computed_at,
      is_stale: isStale,
      next_scheduled_refresh: nextScheduledRefresh(),
      formula_version: summary.formula_version,
      source_version: top[0]?.source_version ?? null,
      assumptions,
      classifications: CLASSIFICATIONS,
      top_conversions: top.map(mapValuationRow),
    };

    await cacheSet(cacheKey, body, CACHE_TTL);
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Material value API error:', error);
    // Never echo SQL/driver text to clients
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
