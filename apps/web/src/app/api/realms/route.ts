import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'edge';

export async function GET() {
  const sql = getDb();
  const region = process.env.REGION || 'us';

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

  return NextResponse.json(rows);
}
