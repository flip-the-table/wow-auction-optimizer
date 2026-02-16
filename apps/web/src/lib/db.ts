/**
 * Database client for Next.js API routes.
 * Uses @neondatabase/serverless for Netlify serverless functions.
 * Falls back to standard pg for local dev.
 */

import { neon } from '@neondatabase/serverless';

// Neon serverless SQL tagged template
export function getDb() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL environment variable is required');
    }
    return neon(databaseUrl);
}

export type SqlClient = ReturnType<typeof neon>;
