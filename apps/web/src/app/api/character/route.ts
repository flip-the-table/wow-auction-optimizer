import { NextRequest, NextResponse } from 'next/server';
import { getCharacterProfile } from '@/lib/blizzard';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
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

    const profile = await getCharacterProfile(realm, name);
    if (profile === null) {
      return NextResponse.json(
        { error: 'Character not found — check spelling, or the profile may be hidden' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(profile, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error: any) {
    console.error('Character API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
