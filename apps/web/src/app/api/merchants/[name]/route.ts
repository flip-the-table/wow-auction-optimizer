import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';

// One merchant's tracked listings: live now, sold-ish, ambiguous — with item
// metadata. Small per-seller row counts; no caching needed.
export async function GET(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  try {
    const region = process.env.REGION || 'us';
    const seller = decodeURIComponent(params.name || '').slice(0, 128);
    const { searchParams } = new URL(request.url);
    const realmRaw = parseInt(searchParams.get('realm') ?? '', 10);
    const realm = Number.isFinite(realmRaw) ? realmRaw : null;
    if (seller.length < 2) {
      return NextResponse.json({ error: 'invalid seller' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT ao.auction_id, ao.item_id, ao.unit_price, ao.quantity, ao.scanned_at,
             ao.connected_realm_id,
             oc.outcome, oc.removed_at,
             (la.auction_id IS NOT NULL) AS live_now,
             i.name AS item_name, i.quality, m.icon_url,
             r.name AS realm_name
      FROM auction_owners ao
      LEFT JOIN auction_outcomes oc
        ON oc.region = ao.region AND oc.connected_realm_id = ao.connected_realm_id
       AND oc.auction_id = ao.auction_id
      LEFT JOIN live_auctions la
        ON la.region = ao.region AND la.connected_realm_id = ao.connected_realm_id
       AND la.auction_id = ao.auction_id
      LEFT JOIN items i ON i.id = ao.item_id
      LEFT JOIN item_media m ON m.item_id = ao.item_id
      LEFT JOIN (
        SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
      ) r ON r.connected_realm_id = ao.connected_realm_id
      WHERE ao.region = ${region}
        AND ao.seller = ${seller}
        ${realm !== null ? sql`AND ao.connected_realm_id = ${realm}` : sql``}
      ORDER BY (la.auction_id IS NOT NULL) DESC, oc.removed_at DESC NULLS LAST, ao.scanned_at DESC
      LIMIT 500
    `;

    const listings = rows.map((x: any) => ({
      auction_id: Number(x.auction_id),
      connected_realm_id: x.connected_realm_id,
      realm_name: x.realm_name,
      item: { item_id: x.item_id, name: x.item_name, quality: x.quality, icon_url: x.icon_url },
      unit_price: x.unit_price != null ? Number(x.unit_price) : null,
      quantity: x.quantity,
      scanned_at: x.scanned_at,
      status: x.live_now ? 'live' : (x.outcome ?? 'unknown'),
      removed_at: x.removed_at,
    }));

    const soldIsh = listings.filter(l => l.status === 'early');
    const responseBody = {
      status: listings.length > 0 ? 'ok' : 'no_data',
      region,
      seller,
      stats: {
        tracked: listings.length,
        live_now: listings.filter(l => l.status === 'live').length,
        sold_ish: soldIsh.length,
        ambiguous: listings.filter(l => l.status === 'ambiguous').length,
        gold_early: soldIsh.reduce((s, l) => s + (l.unit_price ?? 0), 0),
        distinct_items: new Set(listings.map(l => l.item.item_id)).size,
      },
      listings,
      generated_at: new Date().toISOString(),
    };

    return NextResponse.json(responseBody, {
      headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
    });
  } catch (error: any) {
    console.error('Merchant profile API error:', error);
    return NextResponse.json({ error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
