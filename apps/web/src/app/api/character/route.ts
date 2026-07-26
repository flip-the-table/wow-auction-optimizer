import { NextRequest, NextResponse } from 'next/server';
import { getCharacterProfessions } from '@/lib/blizzard';
import { cacheGet, cacheSet } from '@/lib/cache';

export const runtime = 'nodejs';

const CACHE_TTL = 3600; // known recipes change slowly

export async function GET(request: NextRequest) {
  try {
    const region = process.env.REGION || 'us';
    const { searchParams } = new URL(request.url);

    const realm = (searchParams.get('realm') || '').toLowerCase().trim();
    const name = (searchParams.get('name') || '').trim();

    // Realm slugs are ascii kebab-case; character names are 2-12 chars and may
    // contain accented letters — validate loosely, encode strictly.
    if (!/^[a-z0-9-]{2,64}$/.test(realm) || name.length < 2 || name.length > 12) {
      return NextResponse.json(
        { error: 'Provide a valid realm slug and character name' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const cacheKey = `char:${region}:${realm}:${name.toLowerCase()}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'private, max-age=300', 'X-Cache': 'HIT' },
      });
    }

    const data = await getCharacterProfessions(realm, name);
    if (data === null) {
      return NextResponse.json(
        { error: 'Character not found — check spelling, or the profile may be hidden' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Flatten primaries + secondaries into professions with known recipe IDs
    const professions: any[] = [];
    const knownRecipeIds: number[] = [];
    for (const group of [...(data.primaries ?? []), ...(data.secondaries ?? [])]) {
      const prof = group.profession ?? {};
      const tiers = (group.tiers ?? []).map((t: any) => {
        const ids = (t.known_recipes ?? []).map((r: any) => r.id).filter((x: any) => x != null);
        knownRecipeIds.push(...ids);
        return {
          tier_id: t.tier?.id ?? null,
          tier_name: t.tier?.name ?? null,
          skill_points: t.skill_points ?? null,
          max_skill_points: t.max_skill_points ?? null,
          known_recipe_count: ids.length,
        };
      });
      professions.push({
        profession_id: prof.id ?? null,
        profession_name: prof.name ?? null,
        tiers,
      });
    }

    const responseBody = {
      character: { name, realm_slug: realm, region },
      professions,
      known_recipe_ids: knownRecipeIds,
      generated_at: new Date().toISOString(),
    };

    await cacheSet(cacheKey, responseBody, CACHE_TTL);

    return NextResponse.json(responseBody, {
      headers: { 'Cache-Control': 'private, max-age=300', 'X-Cache': 'MISS' },
    });
  } catch (error: any) {
    console.error('Character API error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
