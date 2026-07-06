/**
 * Lazily-created singleton `pg` Pool. No queries, no schema knowledge —
 * just the connection. `migrate.ts` and future ingestion code both import
 * this rather than constructing their own Pool.
 */
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (see .env.example)');
    }

    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
      console.error('[db] unexpected idle client error', err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
