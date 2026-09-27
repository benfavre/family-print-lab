// Family features for kids: gentle print limits per child, the family photo gallery of finished
// prints, and the badges kids earn (modules/kids).
import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jobs, profiles } from './core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/** Limits for one child; a null column means no limit of that kind. */
export const kidLimits = sqliteTable('kid_limits', {
	profileId: text('profile_id')
		.primaryKey()
		.references(() => profiles.id, { onDelete: 'cascade' }),
	printsPerDay: integer('prints_per_day'),
	printsPerWeek: integer('prints_per_week'),
	gramsPerWeek: integer('grams_per_week'),
	gramsPerMonth: integer('grams_per_month'),
	/** Requests up to this many grams (and within the limits) are said yes to without asking. */
	needApprovalOverGrams: integer('need_approval_over_grams'),
	updatedAt: text('updated_at').notNull().default(now)
});

/** A photo of something a child made (WebP or JPEG, at most 400 KB), kept in the database for backups. */
export const galleryItems = sqliteTable(
	'gallery_items',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id, { onDelete: 'cascade' }),
		image: blob('image', { mode: 'buffer' }).notNull(),
		mime: text('mime').$type<'image/webp' | 'image/jpeg'>().notNull(),
		/** 'camera' (taken by the printer when the print finished) or 'upload'. */
		source: text('source').$type<'camera' | 'upload'>().notNull().default('upload'),
		caption: text('caption').notNull().default(''),
		createdAt: text('created_at').notNull().default(now)
	},
	(t) => [
		index('gallery_items_profile').on(t.profileId, t.createdAt),
		index('gallery_items_job').on(t.jobId)
	]
);

/** Badges a child earned, each once, with the print that earned it. */
export const kidBadges = sqliteTable(
	'kid_badges',
	{
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id, { onDelete: 'cascade' }),
		badge: text('badge').notNull(),
		earnedAt: text('earned_at').notNull().default(now),
		jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' })
	},
	(t) => [primaryKey({ columns: [t.profileId, t.badge] })]
);
