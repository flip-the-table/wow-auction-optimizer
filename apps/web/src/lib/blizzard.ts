/**
 * Server-side Blizzard API helper for Next.js API routes.
 * Client-credentials OAuth token (cached in Redis + module memory) and the
 * public character professions profile endpoint (no user OAuth required).
 */

import { cacheGet, cacheSet } from './cache';

interface TokenInfo {
    token: string;
    expiresAt: number; // epoch ms
}

let memToken: TokenInfo | null = null;

async function getAppToken(): Promise<string> {
    const now = Date.now();
    if (memToken && now < memToken.expiresAt - 60_000) return memToken.token;

    const cached = await cacheGet<TokenInfo>('blizzard:app_token');
    if (cached && now < cached.expiresAt - 60_000) {
        memToken = cached;
        return cached.token;
    }

    const id = process.env.BLIZZARD_CLIENT_ID;
    const secret = process.env.BLIZZARD_CLIENT_SECRET;
    if (!id || !secret) {
        throw new Error('Blizzard API credentials not configured');
    }

    const res = await fetch('https://oauth.battle.net/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Blizzard OAuth failed: ${res.status}`);
    const data = await res.json();

    const info: TokenInfo = {
        token: data.access_token,
        expiresAt: now + (data.expires_in ?? 86400) * 1000,
    };
    memToken = info;
    await cacheSet('blizzard:app_token', info, Math.max(60, (data.expires_in ?? 86400) - 300));
    return info.token;
}

/**
 * Character Professions Summary (public profile namespace).
 * Returns parsed JSON, or null when the character doesn't exist or the
 * profile is hidden (Blizzard returns 404 for both).
 */
export async function getCharacterProfessions(
    realmSlug: string,
    characterName: string
): Promise<any | null> {
    const region = process.env.REGION || 'us';
    const token = await getAppToken();
    const name = encodeURIComponent(characterName.toLowerCase());
    const url =
        `https://${region}.api.blizzard.com/profile/wow/character/` +
        `${encodeURIComponent(realmSlug)}/${name}/professions` +
        `?namespace=profile-${region}&locale=en_US`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Blizzard API error: ${res.status}`);
    return res.json();
}
