import { sql } from 'drizzle-orm';
import { blob, check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
	Category,
	JobStatus,
	KidLevel,
	PrintRequestStatus,
	ProfileColor,
	ProjectStatus,
	SlicedInfo
} from '../../shared/domain';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const timestamps = {
	version: integer('version').notNull().default(1),
	createdAt: text('created_at').notNull().default(now),
	updatedAt: text('updated_at').notNull().default(now)
};

export const profiles = sqliteTable(
	'profiles',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		age: integer('age'),
		color: text('color').$type<ProfileColor>().notNull(),
		interests: text('interests').notNull().default(''),
		/** Kid mode for this profile: a simpler, safer space ('little' about 3–6, 'junior' about 7–12). */
		kid: text('kid').$type<KidLevel>(),
		...timestamps
	},
	(t) => [check('profiles_age', sql`${t.age} IS NULL OR (${t.age} BETWEEN 0 AND 120)`)]
);

export const projects = sqliteTable(
	'projects',
	{
		id: text('id').primaryKey(),
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id, { onDelete: 'restrict' }),
		title: text('title').notNull(),
		status: text('status').$type<ProjectStatus>().notNull().default('Idea'),
		category: text('category').$type<Category>().notNull().default('Home'),
		description: text('description').notNull().default(''),
		notes: text('notes').notNull().default(''),
		url: text('url').notNull().default(''),
		files: text('files').notNull().default(''),
		material: text('material').notNull().default(''),
		pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
		...timestamps
	},
	(t) => [index('projects_profile').on(t.profileId), index('projects_status').on(t.status)]
);

export const checklistItems = sqliteTable(
	'checklist_items',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		text: text('text').notNull(),
		done: integer('done', { mode: 'boolean' }).notNull().default(false),
		position: integer('position').notNull().default(0)
	},
	(t) => [index('checklist_project').on(t.projectId, t.position)]
);

export const spools = sqliteTable(
	'spools',
	{
		id: text('id').primaryKey(),
		brand: text('brand').notNull().default(''),
		material: text('material').notNull(),
		colorName: text('color_name').notNull().default(''),
		colorHex: text('color_hex').notNull(),
		totalGrams: real('total_grams').notNull(),
		remainingGrams: real('remaining_grams').notNull(),
		cost: real('cost'),
		notes: text('notes').notNull().default(''),
		...timestamps
	},
	(t) => [
		check(
			'spools_weights',
			sql`${t.totalGrams} > 0 AND ${t.remainingGrams} >= 0 AND ${t.remainingGrams} <= ${t.totalGrams}`
		)
	]
);

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		status: text('status').$type<JobStatus>().notNull().default('Queued'),
		revision: text('revision').notNull().default(''),
		spoolId: text('spool_id').references(() => spools.id, { onDelete: 'set null' }),
		material: text('material').notNull().default(''),
		grams: real('grams'),
		minutes: real('minutes'),
		actualMinutes: real('actual_minutes'),
		layerHeight: text('layer_height').notNull().default(''),
		nozzle: text('nozzle').notNull().default(''),
		plate: text('plate').notNull().default(''),
		supports: text('supports').notNull().default('None'),
		infill: integer('infill'),
		notes: text('notes').notNull().default(''),
		printerTask: text('printer_task').notNull().default(''),
		/** The exact model version this job printed (optional). */
		modelVersionId: text('model_version_id').references(() => modelVersions.id, {
			onDelete: 'set null'
		}),
		/** The attached sliced print file (.gcode.3mf) and what it contains. */
		sliced: text('sliced', { mode: 'json' }).$type<SlicedInfo>(),
		/** Filament already deducted from a spool for this job, so edits and deletes can refund it exactly. */
		chargeSpoolId: text('charge_spool_id').references(() => spools.id, { onDelete: 'set null' }),
		chargeGrams: real('charge_grams').notNull().default(0),
		startedAt: text('started_at'),
		finishedAt: text('finished_at'),
		...timestamps
	},
	(t) => [
		index('jobs_project').on(t.projectId),
		index('jobs_status').on(t.status),
		index('jobs_printer_task').on(t.printerTask)
	]
);

export const models = sqliteTable(
	'models',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** 'parametric': OpenSCAD source, re-rendered per version. 'mesh': an imported or edited triangle mesh. */
		kind: text('kind').$type<'parametric' | 'mesh'>().notNull(),
		currentVersionId: text('current_version_id'),
		...timestamps
	},
	(t) => [index('models_project').on(t.projectId)]
);

export const modelVersions = sqliteTable(
	'model_versions',
	{
		id: text('id').primaryKey(),
		modelId: text('model_id')
			.notNull()
			.references(() => models.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		source: text('source').notNull().default(''),
		params: text('params', { mode: 'json' })
			.$type<Record<string, string | number | boolean>>()
			.notNull()
			.default({}),
		/** Rendered or imported mesh, stored as binary STL under data/models/<modelId>/. */
		file: text('file').notNull(),
		note: text('note').notNull().default(''),
		origin: text('origin').notNull().default('editor'),
		triangles: integer('triangles').notNull().default(0),
		sizeX: real('size_x').notNull().default(0),
		sizeY: real('size_y').notNull().default(0),
		sizeZ: real('size_z').notNull().default(0),
		volume: real('volume').notNull().default(0),
		hasThumbnail: integer('has_thumbnail', { mode: 'boolean' }).notNull().default(false),
		createdAt: text('created_at').notNull().default(now)
	},
	(t) => [index('model_versions_model').on(t.modelId, t.number)]
);

export const activity = sqliteTable(
	'activity',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		at: text('at').notNull().default(now),
		kind: text('kind').notNull(),
		message: text('message').notNull(),
		projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' })
	},
	(t) => [index('activity_project').on(t.projectId, t.at)]
);

export const meta = sqliteTable('meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

/** Hand-drawn sketches for a project's idea, stored as PNG in the database (so backups include them). */
export const sketches = sqliteTable(
	'sketches',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		title: text('title').notNull().default(''),
		png: blob('png', { mode: 'buffer' }).notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		...timestamps
	},
	(t) => [index('sketches_project').on(t.projectId)]
);

/** A child asks a grown-up to print something they made in kid mode. */
export const printRequests = sqliteTable(
	'print_requests',
	{
		id: text('id').primaryKey(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id, { onDelete: 'cascade' }),
		modelVersionId: text('model_version_id').references(() => modelVersions.id, {
			onDelete: 'set null'
		}),
		/** The spool (colour) the child picked, if any. */
		spoolId: text('spool_id').references(() => spools.id, { onDelete: 'set null' }),
		status: text('status').$type<PrintRequestStatus>().notNull().default('Waiting'),
		/** What the child said when asking. */
		message: text('message').notNull().default(''),
		/** The grown-up's answer, shown to the child. */
		reply: text('reply').notNull().default(''),
		/** The print job created when the request was approved. */
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
		decidedAt: text('decided_at'),
		...timestamps
	},
	(t) => [
		index('print_requests_status').on(t.status),
		index('print_requests_project').on(t.projectId)
	]
);
