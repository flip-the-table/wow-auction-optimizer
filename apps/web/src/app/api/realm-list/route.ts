import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL = 21600; // 6h — realm list is nearly static

/** Individual realms (slug + name) for character lookup dropdowns. */
export async function GET() {
  try {
    const region = process.env.REGION || 'us';

    const cacheKey = `realm-list:${region}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT slug, name, connected_realm_id FROM realms
      WHERE region = ${region}
      ORDER BY name
    `;

    const body = rows.map((r: any) => ({
      slug: r.slug,
      name: r.name,
      connected_realm_id: Number(r.connected_realm_id),
    }));
    await cacheSet(cacheKey, body, CACHE_TTL);

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Realm list API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
