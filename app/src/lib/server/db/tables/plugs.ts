// Smart plugs (Integrations → Home automation): one per printer, so the app can switch a printer on
// before a print and off once it has cooled. Plug passwords and tokens stay on this computer, inside
// `config`; the API never sends them back.
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { PlugKind } from '../../../shared/home-automation';
import { printers } from './printers';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const plugs = sqliteTable(
	'plugs',
	{
		id: text('id').primaryKey(),
		printerId: text('printer_id')
			.notNull()
			.references(() => printers.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<PlugKind>().notNull(),
		/** JSON: address and credentials, per kind (modules/home-automation/validation.ts). */
		config: text('config').notNull(),
		/** Switch the printer on before a print that finds it off. */
		autoOn: integer('auto_on', { mode: 'boolean' }).notNull().default(true),
		/** Switch it off after a print, once cool. */
		autoOff: integer('auto_off', { mode: 'boolean' }).notNull().default(false),
		cooldownMinutes: integer('cooldown_minutes').notNull().default(10),
		/** °C: the nozzle must be below this before power is cut. */
		offBelowNozzle: integer('off_below_nozzle').notNull().default(50),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [uniqueIndex('plugs_printer').on(t.printerId)]
);
