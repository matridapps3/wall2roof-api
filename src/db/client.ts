import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { config } from '../config.js';
import * as schema from './schema.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export type Db = ReturnType<typeof drizzlePg<typeof schema>>;

export type DbHandle = { db: Db; close: () => Promise<void> };

/**
 * Railway PostgreSQL in production (DATABASE_URL), embedded PGlite locally,
 * or an in-memory PGlite for tests. Both speak the same Postgres dialect.
 * `migrate: false` leaves a DATABASE_URL database as it is (PGlite is always migrated).
 */
export async function openDb(opts: { memory?: boolean; migrate?: boolean } = {}): Promise<DbHandle> {
  if (config.DATABASE_URL && !opts.memory) {
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      ssl: config.DATABASE_URL.includes('sslmode=disable') ? false : undefined,
    });
    const db = drizzlePg(pool, { schema });
    if (opts.migrate !== false) await migratePg(db, { migrationsFolder });
    return { db, close: () => pool.end() };
  }
  let client: PGlite;
  if (opts.memory) {
    client = new PGlite();
  } else {
    mkdirSync(config.PGLITE_DIR, { recursive: true });
    client = new PGlite(config.PGLITE_DIR);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  // Same query API; the cast lets the rest of the code target one type.
  return { db: db as unknown as Db, close: () => client.close() };
}
