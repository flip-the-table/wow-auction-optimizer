import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';
// Without this, Next.js prerenders this handler at BUILD time and serves the
// same frozen realm list forever (no `request` usage = static route).
export const dynamic = 'force-dynamic';

const CACHE_TTL = 3600; // realms rarely change

export async function GET() {
  try {
    const region = process.env.REGION || 'us';

    const cacheKey = `realms:${region}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT
        r.connected_realm_id,
        MIN(r.name) as name,
        COUNT(r.id)::int as realm_count,
        array_agg(r.name ORDER BY r.name) as all_names
      FROM realms r
      WHERE r.region = ${region}
      GROUP BY r.connected_realm_id
      ORDER BY MIN(r.name)
    `;

    // postgres.js returns plain objects; strip the RowList wrapper for caching
    const body = rows.map((r: any) => ({ ...r }));
    await cacheSet(cacheKey, body, CACHE_TTL);

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Realms API error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
