import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 1800;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Composes today's action plan from every insight engine: almanac rhythms,
// opportunity signals, craft margins, merchant tracking. Each task carries
// its evidence and a deep link. Every source is best-effort — a failed
// source drops its tasks, never the endpoint.
export async function GET(_request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const today = new Date().getUTCDay();
    const dateKey = new Date().toISOString().slice(0, 10);

    const cacheKey = `quests:${region}:${dateKey}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=1800', 'X-Cache': 'HIT' },
      });
    }

    const sql = getDb();
    const tasks: any[] = [];

    // --- Almanac: items peaking / bottoming today ------------------------
    try {
      const rhythm = await sql`
        WITH prof AS (
          SELECT item_id, MAX(rel_price) - MIN(rel_price) AS swing
          FROM item_weekday_profile
          WHERE region = ${region}
          GROUP BY item_id
          HAVING COUNT(*) = 7 AND MIN(obs_days) >= 6
        ),
        fresh AS (
          SELECT DISTINCT ON (o.item_id)
                 o.item_id, o.connected_realm_id, o.current_price
          FROM item_opportunities o
          WHERE o.region = ${region} AND o.computed_at > now() - interval '1 day'
          ORDER BY o.item_id, o.opportunity_score DESC NULLS LAST
        ),
        extremes AS (
          SELECT item_id, MAX(rel_price) AS mx, MIN(rel_price) AS mn
          FROM item_weekday_profile
          WHERE region = ${region}
          GROUP BY item_id
        ),
        today_rel AS (
          SELECT w.item_id, w.rel_price,
                 (w.rel_price >= e.mx) AS is_sell_day,
                 (w.rel_price <= e.mn) AS is_buy_day
          FROM item_weekday_profile w
          JOIN extremes e ON e.item_id = w.item_id
          WHERE w.region = ${region} AND w.dow = ${today}
        )
        SELECT p.item_id, p.swing, t.rel_price,
               t.is_sell_day, t.is_buy_day,
               f.connected_realm_id, f.current_price,
               i.name, i.quality, m.icon_url, r.name AS realm_name
        FROM prof p
        JOIN fresh f ON f.item_id = p.item_id
        JOIN today_rel t ON t.item_id = p.item_id
        LEFT JOIN items i ON i.id = p.item_id
        LEFT JOIN item_media m ON m.item_id = p.item_id
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
        ) r ON r.connected_realm_id = f.connected_realm_id
        WHERE (t.is_sell_day OR t.is_buy_day)
        ORDER BY p.swing DESC
        LIMIT 8
      `;
      for (const x of rhythm.filter((x: any) => x.is_sell_day).slice(0, 2)) {
        tasks.push({
          id: `sell-${x.item_id}-${dateKey}`,
          tag: 'SELL', icon: '🌾',
          title: `List ${x.name ?? `item #${x.item_id}`} today`,
          detail: `${DAYS[today]} is its historic peak (${((x.rel_price - 1) * 100).toFixed(0) > '0' ? '+' : ''}${((x.rel_price - 1) * 100).toFixed(0)}% vs typical) · ${x.realm_name} · ~${Math.round(Number(x.current_price ?? 0) / 10000).toLocaleString()}g`,
          href: `/item/${x.item_id}`,
          item: { item_id: x.item_id, name: x.name, quality: x.quality, icon_url: x.icon_url },
        });
      }
      for (const x of rhythm.filter((x: any) => x.is_buy_day).slice(0, 2)) {
        tasks.push({
          id: `buy-${x.item_id}-${dateKey}`,
          tag: 'BUY', icon: '🌱',
          title: `Stock up on ${x.name ?? `item #${x.item_id}`}`,
          detail: `${DAYS[today]} is its historic trough (${((x.rel_price - 1) * 100).toFixed(0)}% vs typical) · ${x.realm_name} · ~${Math.round(Number(x.current_price ?? 0) / 10000).toLocaleString()}g now`,
          href: `/item/${x.item_id}`,
          item: { item_id: x.item_id, name: x.name, quality: x.quality, icon_url: x.icon_url },
        });
      }
    } catch (e) { console.error('quests: rhythm source failed', e); }

    // --- Opportunities: best buy-window signal ---------------------------
    try {
      const opp = await sql`
        SELECT o.item_id, o.connected_realm_id, o.current_price,
               o.opportunity_score, o.price_percentile_30d,
               i.name, i.quality, m.icon_url, r.name AS realm_name
        FROM item_opportunities o
        LEFT JOIN items i ON i.id = o.item_id
        LEFT JOIN item_media m ON m.item_id = o.item_id
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
        ) r ON r.connected_realm_id = o.connected_realm_id
        WHERE o.region = ${region} AND o.computed_at > now() - interval '1 day'
          AND o.price_percentile_30d <= 0.35
        ORDER BY o.opportunity_score DESC NULLS LAST
        LIMIT 1
      `;
      if (opp[0]) {
        const x: any = opp[0];
        tasks.push({
          id: `opp-${x.item_id}-${x.connected_realm_id}-${dateKey}`,
          tag: 'BUY', icon: '🎯',
          title: `Snipe ${x.name ?? `item #${x.item_id}`} on ${x.realm_name}`,
          detail: `Today's top opportunity (score ${Math.round(Number(x.opportunity_score ?? 0) * 100)}) · price in the bottom ${Math.round(Number(x.price_percentile_30d) * 100)}% of its 30-day range · ~${Math.round(Number(x.current_price ?? 0) / 10000).toLocaleString()}g`,
          href: `/item/${x.item_id}?realm=${x.connected_realm_id}`,
          item: { item_id: x.item_id, name: x.name, quality: x.quality, icon_url: x.icon_url },
        });
      }
    } catch (e) { console.error('quests: opportunity source failed', e); }

    // --- Craft: best evidence-backed margin ------------------------------
    try {
      const craft = await sql`
        SELECT rc.recipe_id, rc.crafted_item_id, rc.craft_cost,
               bm.sell_price, bm.demand_per_day, bm.market_quantity,
               i.name, i.quality, m2.icon_url, r2.name AS realm_name
        FROM recipe_costs rc
        JOIN recipe_market bm
          ON bm.region = rc.region AND bm.crafted_item_id = rc.crafted_item_id
         AND bm.demand_per_day >= 0.3
        LEFT JOIN items i ON i.id = rc.crafted_item_id
        LEFT JOIN item_media m2 ON m2.item_id = rc.crafted_item_id
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
        ) r2 ON r2.connected_realm_id = bm.connected_realm_id
        WHERE rc.region = ${region} AND rc.craft_cost > 0
          AND rc.reagents_priced = rc.reagents_total
          AND bm.sell_price * 0.95 > rc.craft_cost
          -- Evidence bar for a "do this today" call, stricter than the craft
          -- page: a real market (5+ listings), a sane margin ratio (<=10x —
          -- higher usually means troll-priced or under-costed reagents), and
          -- demand capped at half the stock (full-stock turnover = relist
          -- churn, not sales).
          AND bm.market_listings >= 5
          AND (bm.sell_price * 0.95 - rc.craft_cost) <= rc.craft_cost * 10
        ORDER BY (bm.sell_price * 0.95 - rc.craft_cost)
                   * LEAST(bm.demand_per_day, bm.market_listings * 0.5) DESC
        LIMIT 1
      `;
      if (craft[0]) {
        const x: any = craft[0];
        const margin = Math.round((Number(x.sell_price) * 0.95 - Number(x.craft_cost)) / 10000);
        const queue = Number(x.market_quantity) / Math.max(Number(x.demand_per_day), 0.01);
        tasks.push({
          id: `craft-${x.crafted_item_id}-${dateKey}`,
          tag: 'CRAFT', icon: '⚒',
          title: `Craft ${x.name ?? `item #${x.crafted_item_id}`}`,
          detail: `~${margin.toLocaleString()}g margin after cut · sells on ${x.realm_name} · queue ~${queue.toFixed(1)}d · ~${Number(x.demand_per_day).toFixed(1)} removed/day observed`,
          href: `/item/${x.crafted_item_id}`,
          item: { item_id: x.crafted_item_id, name: x.name, quality: x.quality, icon_url: x.icon_url },
        });
      }
    } catch (e) { console.error('quests: craft source failed', e); }

    // --- Merchants: follow the smart money -------------------------------
    try {
      const owners = await sql`
        SELECT ao.seller, ao.connected_realm_id, r.name AS realm_name,
               COUNT(oc.auction_id) FILTER (WHERE oc.outcome = 'early')::int AS sold_ish,
               COUNT(la.auction_id)::int AS live_now
        FROM auction_owners ao
        LEFT JOIN auction_outcomes oc
          ON oc.region = ao.region AND oc.connected_realm_id = ao.connected_realm_id
         AND oc.auction_id = ao.auction_id
        LEFT JOIN live_auctions la
          ON la.region = ao.region AND la.connected_realm_id = ao.connected_realm_id
         AND la.auction_id = ao.auction_id
        LEFT JOIN (
          SELECT connected_realm_id, MIN(name) AS name FROM realms GROUP BY connected_realm_id
        ) r ON r.connected_realm_id = ao.connected_realm_id
        WHERE ao.region = ${region}
        GROUP BY ao.seller, ao.connected_realm_id, r.name
        HAVING COUNT(oc.auction_id) FILTER (WHERE oc.outcome = 'early') >= 3
        ORDER BY sold_ish DESC
        LIMIT 1
      `;
      if (owners[0]) {
        const x: any = owners[0];
        tasks.push({
          id: `merchant-${x.seller}-${dateKey}`,
          tag: 'SCOUT', icon: '🏪',
          title: `Review ${x.seller}'s listings`,
          detail: `${x.sold_ish} tracked listings moved early on ${x.realm_name} · ${x.live_now} live now — what else do they know?`,
          href: `/merchants/${encodeURIComponent(x.seller)}?realm=${x.connected_realm_id}`,
        });
      } else {
        const anyOwners = await sql`SELECT 1 FROM auction_owners WHERE region = ${region} LIMIT 1`;
        if (anyOwners.length === 0) {
          tasks.push({
            id: `scan-${dateKey}`,
            tag: 'SCOUT', icon: '🔍',
            title: 'Run /fttscan at the Auction House',
            detail: 'Seller tracking has no data yet — one in-game scan starts attributing listings to merchants so we can follow the winners.',
            href: '/merchants',
          });
        }
      }
    } catch (e) { console.error('quests: merchant source failed', e); }

    const responseBody = {
      status: tasks.length > 0 ? 'ok' : 'no_data',
      region,
      date: dateKey,
      today_dow: today,
      tasks,
      generated_at: new Date().toISOString(),
    };

    if (responseBody.status === 'ok') await cacheSet(cacheKey, responseBody, CACHE_TTL);
    return NextResponse.json(responseBody, {
      headers: {
        'Cache-Control': responseBody.status === 'ok'
          ? 'public, s-maxage=300, stale-while-revalidate=1800'
          : 'public, s-maxage=60, stale-while-revalidate=120',
        'X-Cache': 'MISS',
      },
    });
  } catch (error: any) {
    console.error('Quests API error:', error);
    return NextResponse.json({ error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
