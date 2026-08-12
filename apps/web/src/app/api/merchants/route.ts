import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 900;

// Seller analytics exist only where the operator has run /fttscan in-game —
// the web API never exposes seller identity. Outcomes come from our own
// auction-ID lifecycle tracking; 'early' = provably not expired.
export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

    const cacheKey = `merchants:${region}:${limit}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900', 'X-Cache': 'HIT' },
      });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT ao.seller,
             ao.connected_realm_id,
             r.name AS realm_name,
             COUNT(*)::int AS tracked,
             COUNT(oc.auction_id) FILTER (WHERE oc.outcome = 'early')::int AS sold_ish,
             COUNT(oc.auction_id) FILTER (WHERE oc.outcome = 'ambiguous')::int AS ambiguous,
             COUNT(la.auction_id)::int AS live_now,
             COALESCE(SUM(ao.unit_price) FILTER (WHERE oc.outcome = 'early'), 0)::bigint AS gold_early,
             COUNT(DISTINCT ao.item_id)::int AS distinct_items,
             MAX(ao.scanned_at) AS last_scanned
      FROM auction_owners ao
      LEFT JOIN auction_outcomes oc
        ON oc.region = ao.region
       AND oc.connected_realm_id = ao.connected_realm_id
       AND oc.auction_id = ao.auction_id
      LEFT JOIN live_auctions la
        ON la.region = ao.region
       AND la.connected_realm_id = ao.connected_realm_id
       AND la.auction_id = ao.auction_id
      LEFT JOIN (
        SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
      ) r ON r.connected_realm_id = ao.connected_realm_id
      WHERE ao.region = ${region}
      GROUP BY ao.seller, ao.connected_realm_id, r.name
      ORDER BY sold_ish DESC, tracked DESC
      LIMIT ${limit}
    `;

    const responseBody = {
      status: rows.length > 0 ? 'ok' : 'no_data',
      region,
      merchants: rows.map((m: any) => ({
        seller: m.seller,
        connected_realm_id: m.connected_realm_id,
        realm_name: m.realm_name,
        tracked: m.tracked,
        sold_ish: m.sold_ish,
        ambiguous: m.ambiguous,
        live_now: m.live_now,
        gold_early: Number(m.gold_early),
        distinct_items: m.distinct_items,
        last_scanned: m.last_scanned,
      })),
      generated_at: new Date().toISOString(),
    };

    if (responseBody.status === 'ok') await cacheSet(cacheKey, responseBody, CACHE_TTL);
    return NextResponse.json(responseBody, {
      headers: {
        'Cache-Control': responseBody.status === 'ok'
          ? 'public, s-maxage=300, stale-while-revalidate=900'
          : 'public, s-maxage=60, stale-while-revalidate=120',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Merchants API error:', error);
    return NextResponse.json({ error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
