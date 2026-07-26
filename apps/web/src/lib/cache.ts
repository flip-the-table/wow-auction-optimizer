/**
 * Upstash Redis cache layer for API responses.
 * Uses HTTP-based client (no TCP connections, works in serverless/edge).
 * Falls back gracefully — cache misses just hit the DB directly.
 */

import { Redis } from '@upstash/redis';

let redis: Redis | null = null;

function getRedis(): Redis | null {
    if (redis) return redis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    redis = new Redis({ url, token });
    return redis;
}

/**
 * Try to get a cached JSON value. Returns null on miss or error.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
    try {
        const r = getRedis();
        if (!r) return null;
        const val = await r.get<T>(key);
        return val ?? null;
    } catch (e) {
        console.warn('Cache get error:', e);
        return null;
    }
}

/**
 * Set a cached JSON value with TTL in seconds. Errors are swallowed.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
    try {
        const r = getRedis();
        if (!r) return;
        await r.set(key, value, { ex: ttlSeconds });
    } catch (e) {
        console.warn('Cache set error:', e);
    }
}

/**
 * Ping Redis to verify connectivity. Returns false when unconfigured or unreachable.
 */
export async function cachePing(): Promise<boolean> {
    try {
        const r = getRedis();
        if (!r) return false;
        const res = await r.ping();
        return res === 'PONG';
    } catch {
        return false;
    }
}

/**
 * Delete a cached key. Errors are swallowed.
 */
export async function cacheDel(key: string): Promise<void> {
    try {
        const r = getRedis();
        if (!r) return;
        await r.del(key);
    } catch (e) {
        console.warn('Cache del error:', e);
    }
}
