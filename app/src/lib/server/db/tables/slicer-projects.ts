// Slicer projects (slicer-3mf): a Bambu Studio project file (.3mf) kept for a project, with its
// meshes stored once by content under the module's data folder. The file on disk is the source of
// truth; the row names it and counts its saves.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projects } from './core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const slicerProjects = sqliteTable(
	'slicer_projects',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** File name of the .3mf in the module's projects folder. */
		file: text('file').notNull(),
		/** Goes up on every save; a save naming an older revision is refused. */
		revision: integer('revision').notNull().default(1),
		createdAt: text('created_at').notNull().default(now),
		updatedAt: text('updated_at').notNull().default(now)
	},
	(t) => [index('slicer_projects_project').on(t.projectId)]
);
