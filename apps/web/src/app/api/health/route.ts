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

  return NextResponse.json(
    {
      status: dbOk ? 'ok' : 'degraded',
      db_connected: dbOk,
      redis_connected: redisOk,
      last_ingest_at: lastIngest,
      last_compute_at: lastCompute,
      realm_count: realmCount,
      item_count: itemCount,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
