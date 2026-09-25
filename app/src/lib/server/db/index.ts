import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Opens (or creates) a database, applies pending migrations, and tunes it for a single-node app. */
export function openDatabase(file: string, migrationsFolder = path.resolve('drizzle')): DB {
	if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	const client = new Database(file);
	client.pragma('journal_mode = WAL');
	client.pragma('synchronous = NORMAL');
	client.pragma('foreign_keys = ON');
	client.pragma('busy_timeout = 5000');
	const db = drizzle(client, { schema }) as DB;
	migrate(db, { migrationsFolder });
	return db;
}

export { schema };
