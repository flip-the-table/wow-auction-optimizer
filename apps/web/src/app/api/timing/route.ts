import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 1800; // rhythm changes once a day at most

// Profile quality gates: all 7 weekdays present, each observed on at least
// this many distinct dates (90d retention ≈ 12-13 possible per weekday).
const MIN_OBS_PER_DOW = 6;

export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(searchParams.get('limit') ?? '30', 10) || 30, 1),
      100
    );

    const cacheKey = `timing:${region}:${limit}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800',
          'X-Cache': 'HIT',
        },
      });
    }

    const sql = getDb();

    // Items with a complete, well-observed rhythm AND a fresh market signal
    // (item_opportunities recomputes every run — stale = delisted). One row
    // per item: its strongest-signal realm for display context.
    const topItems = await sql`
      WITH prof AS (
        SELECT item_id,
               MAX(rel_price) - MIN(rel_price) AS swing,
               MIN(obs_days) AS obs_min
        FROM item_weekday_profile
        WHERE region = ${region}
        GROUP BY item_id
        HAVING COUNT(*) = 7 AND MIN(obs_days) >= ${MIN_OBS_PER_DOW}
      ),
      fresh AS (
        SELECT DISTINCT ON (o.item_id)
               o.item_id, o.connected_realm_id, o.current_price,
               o.price_percentile_30d, o.opportunity_score, o.listing_count
        FROM item_opportunities o
        WHERE o.region = ${region}
          AND o.computed_at > now() - interval '1 day'
        ORDER BY o.item_id, o.opportunity_score DESC NULLS LAST
      )
      SELECT p.item_id, p.swing, p.obs_min,
             f.connected_realm_id, f.current_price, f.price_percentile_30d,
             f.opportunity_score, f.listing_count,
             i.name, i.quality, m.icon_url, r.name AS realm_name
      FROM prof p
      JOIN fresh f ON f.item_id = p.item_id
      LEFT JOIN items i ON i.id = p.item_id
      LEFT JOIN item_media m ON m.item_id = p.item_id
      LEFT JOIN (
        SELECT connected_realm_id, MIN(name) AS name
        FROM realms GROUP BY connected_realm_id
      ) r ON r.connected_realm_id = f.connected_realm_id
      ORDER BY p.swing DESC
      LIMIT ${limit}
    `;

    const itemIds = topItems.map((r: any) => r.item_id);
    const profileRows = itemIds.length
      ? await sql`
          SELECT item_id, dow, rel_price, rel_demand
          FROM item_weekday_profile
          WHERE region = ${region} AND item_id = ANY(${itemIds})
          ORDER BY item_id, dow
        `
      : [];
    const profMap = new Map<number, { rel_price: number; rel_demand: number | null }[]>();
    for (const p of profileRows) {
      if (!profMap.has(p.item_id)) profMap.set(p.item_id, new Array(7).fill(null));
      profMap.get(p.item_id)![p.dow] = {
        rel_price: Number(p.rel_price),
        rel_demand: p.rel_demand != null ? Number(p.rel_demand) : null,
      };
    }

    // Market-wide ribbon: average rhythm across every qualified live item
    // (equal weight per item — normalization already removed price levels)
    const marketRows = await sql`
      WITH prof AS (
        SELECT item_id FROM item_weekday_profile
        WHERE region = ${region}
        GROUP BY item_id
        HAVING COUNT(*) = 7 AND MIN(obs_days) >= ${MIN_OBS_PER_DOW}
      ),
      fresh AS (
        SELECT DISTINCT item_id FROM item_opportunities
        WHERE region = ${region} AND computed_at > now() - interval '1 day'
      )
      SELECT w.dow,
             AVG(w.rel_price) AS rel_price,
             AVG(w.rel_demand) AS rel_demand,
             COUNT(*)::int AS items
      FROM item_weekday_profile w
      JOIN prof p ON p.item_id = w.item_id
      JOIN fresh f ON f.item_id = w.item_id
      WHERE w.region = ${region}
      GROUP BY w.dow
      ORDER BY w.dow
    `;

    const items = topItems.map((r: any) => {
      const profile = profMap.get(r.item_id) ?? [];
      let buyDow = -1;
      let sellDow = -1;
      profile.forEach((p, d) => {
        if (!p) return;
        if (buyDow < 0 || p.rel_price < profile[buyDow]!.rel_price) buyDow = d;
        if (sellDow < 0 || p.rel_price > profile[sellDow]!.rel_price) sellDow = d;
      });
      return {
        item: {
          item_id: r.item_id,
          name: r.name,
          quality: r.quality,
          icon_url: r.icon_url,
        },
        connected_realm_id: r.connected_realm_id,
        realm_name: r.realm_name,
        current_price: r.current_price != null ? Number(r.current_price) : null,
        price_percentile_30d:
          r.price_percentile_30d != null ? Number(r.price_percentile_30d) : null,
        listing_count: r.listing_count != null ? Number(r.listing_count) : null,
        profile: profile.map((p) => (p ? p.rel_price : null)),
        obs_min: Number(r.obs_min),
        buy_dow: buyDow,
        sell_dow: sellDow,
        swing_pct: Number(r.swing),
      };
    });

    const responseBody = {
      status: items.length > 0 ? 'ok' : 'no_data',
      region,
      // UTC day-of-week: daily history is bucketed by UTC date
      today_dow: new Date().getUTCDay(),
      market: marketRows.map((m: any) => ({
        dow: m.dow,
        rel_price: Number(m.rel_price),
        rel_demand: m.rel_demand != null ? Number(m.rel_demand) : null,
        items: Number(m.items),
      })),
      items,
      generated_at: new Date().toISOString(),
    };

    if (responseBody.status === 'ok') {
      await cacheSet(cacheKey, responseBody, CACHE_TTL);
    }

    return NextResponse.json(responseBody, {
      headers: {
        'Cache-Control':
          responseBody.status === 'ok'
            ? 'public, s-maxage=300, stale-while-revalidate=1800'
            : 'public, s-maxage=60, stale-while-revalidate=120',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Timing API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
