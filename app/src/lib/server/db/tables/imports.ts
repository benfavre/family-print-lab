// Where imported projects came from (model-import): the model page, its designer and licence, so the
// credit stays with the project even if its description is edited.
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ImportSite } from '../../../shared/model-import';
import { projects } from './core';

export const projectSources = sqliteTable(
	'project_sources',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		site: text('site').$type<ImportSite>().notNull(),
		url: text('url').notNull(),
		title: text('title').notNull(),
		author: text('author'),
		authorUrl: text('author_url'),
		licence: text('licence'),
		licenceUrl: text('licence_url'),
		/** [{ url, sketchId }] — the pictures and the sketches they were saved as (null when not saved). */
		images: text('images', { mode: 'json' })
			.$type<{ url: string; sketchId: string | null }[]>()
			.notNull()
			.default(sql`'[]'`),
		importedAt: text('imported_at')
			.notNull()
			.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
	},
	(t) => [index('project_sources_project').on(t.projectId)]
);
