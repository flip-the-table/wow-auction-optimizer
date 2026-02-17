/**
 * Database client for Next.js API routes.
 * Uses 'postgres' (porsager/postgres) for standard PostgreSQL connections.
 * Compatible with AWS RDS, Neon, Supabase, or any Postgres instance.
 */

import postgres from 'postgres';

let sql: postgres.Sql | null = null;

export function getDb() {
    if (sql) return sql;

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL environment variable is required');
    }
    sql = postgres(databaseUrl, {
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
        ssl: 'require',
    });
    return sql;
}

export type SqlClient = postgres.Sql;
