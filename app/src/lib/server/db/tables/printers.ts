// Saved printers (Settings → Printers). Access codes stay on this computer: never sent to the browser,
// never logged, left out of workspace exports (they are in the local SQLite backups, which the cloud
// only stores encrypted).
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ModelCode } from '../../../shared/printers/models';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const printers = sqliteTable(
	'printers',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		model: text('model').$type<ModelCode>().notNull(),
		host: text('host').notNull(),
		serial: text('serial').notNull(),
		accessCode: text('access_code').notNull(),
		port: integer('port').notNull().default(8883),
		ftpPort: integer('ftp_port').notNull().default(990),
		tls: integer('tls', { mode: 'boolean' }).notNull().default(true),
		simulated: integer('simulated', { mode: 'boolean' }).notNull().default(false),
		/** SHA-256 of the printer's certificate, pinned on first use when the Bambu CAs do not cover it. */
		tlsPin: text('tls_pin'),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [uniqueIndex('printers_serial').on(t.serial)]
);
