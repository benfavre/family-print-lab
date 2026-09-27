// User slicer presets (Settings → Slicer profiles): like Bambu Studio's user presets, each keeps the
// name of the system preset it inherits from and only the keys it changes.
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ConfigMap } from '../../../shared/slicer/project';
import type { PresetKind } from '../../../shared/slicer/profiles';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const userPresets = sqliteTable(
	'user_presets',
	{
		id: text('id').primaryKey(),
		kind: text('kind').$type<PresetKind>().notNull(),
		name: text('name').notNull(),
		/** The system preset it is based on; null for a preset that stands alone. */
		inherits: text('inherits'),
		/** Only the keys that differ from the parent. */
		config: text('config', { mode: 'json' }).$type<ConfigMap>().notNull().default({}),
		version: integer('version').notNull().default(1),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [uniqueIndex('user_presets_kind_name').on(t.kind, t.name)]
);
