import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL = 900;

/** Current WoW Token price + 7-day change (from history when available). */
export async function GET() {
  try {
    const region = process.env.REGION || 'us';

    const cacheKey = `token:${region}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();
    let current: any;
    let weekAgo: any;
    // When the market data itself was last written. This endpoint is fetched
    // on every page (SiteNav's token chip), so it is the cheapest place to
    // carry a global freshness signal — features_latest is a ~600-row table,
    // so MAX() here is trivial. Best-effort: never fail the token for it.
    let marketDataAsOf: string | null = null;
    try {
      const [fresh] = await sql`
        SELECT MAX(updated_at) AS as_of FROM item_realm_features_latest
        WHERE region = ${region}
      `;
      marketDataAsOf = fresh?.as_of ?? null;
    } catch { /* table may not exist yet */ }
    try {
      [current] = await sql`
        SELECT price, blizzard_updated_at, updated_at
        FROM wow_token_prices WHERE region = ${region}
      `;
      [weekAgo] = await sql`
        SELECT price FROM wow_token_history
        WHERE region = ${region}
          AND blizzard_updated_at <= NOW() - INTERVAL '7 days'
        ORDER BY blizzard_updated_at DESC LIMIT 1
      `;
    } catch (e: any) {
      if (e?.code === '42P01' || /does not exist/.test(e?.message ?? '')) {
        return NextResponse.json({ status: 'unavailable' }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      throw e;
    }

    if (!current) {
      // Still surface market freshness — the staleness banner must work even
      // when the token price itself is unavailable.
      return NextResponse.json(
        { status: 'unavailable', market_data_as_of: marketDataAsOf },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const price = Number(current.price);
    const prior = weekAgo ? Number(weekAgo.price) : null;
    const body = {
      status: 'ok',
      region,
      price,
      gold: Math.round(price / 10000),
      change_7d_pct: prior ? (price - prior) / prior : null,
      blizzard_updated_at: current.blizzard_updated_at,
      updated_at: current.updated_at,
      market_data_as_of: marketDataAsOf,
    };
    await cacheSet(cacheKey, body, CACHE_TTL);
    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Token API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
