/**
 * Minimal, plain-SQL migration runner — no ORM.
 *
 * Applies every `.sql` file in `./migrations/` in filename order, exactly
 * once each, tracked in a `schema_migrations` table (created here, not as a
 * migration file, to avoid a chicken-and-egg problem). Each migration runs
 * inside its own transaction; a failure rolls back that migration only and
 * stops the run (later migrations are not attempted).
 *
 * Run with: npm run db:migrate
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function loadEnvIfPresent(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const pool = getPool();
  const result = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row) => row.name));
}

async function applyMigration(name: string, sql: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migrate(): Promise<void> {
  loadEnvIfPresent();
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  let ranCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip    ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] running ${file}`);
    await applyMigration(file, sql);
    console.log(`[migrate] done    ${file}`);
    ranCount++;
  }

  console.log(`[migrate] complete — ${ranCount} migration(s) applied, ${files.length} total`);
}

migrate()
  .catch((err: unknown) => {
    console.error('[migrate] failed', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
