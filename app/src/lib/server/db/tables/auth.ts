// Access from other devices (lan-auth): login sessions and per-profile PINs. Only hashes are stored:
// a session row's id is the SHA-256 of the cookie value, a PIN is a salted scrypt hash.
import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { profiles } from './core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const sessions = sqliteTable(
	'sessions',
	{
		/** SHA-256 (hex) of the session cookie; the cookie itself is never stored. */
		id: text('id').primaryKey(),
		/** Who logged in with their PIN; null for the household password. */
		profileId: text('profile_id').references(() => profiles.id, { onDelete: 'cascade' }),
		createdAt: text('created_at').notNull().default(now),
		lastSeenAt: text('last_seen_at').notNull().default(now),
		expiresAt: text('expires_at').notNull(),
		userAgent: text('user_agent').notNull().default(''),
		ip: text('ip').notNull().default('')
	},
	(t) => [index('sessions_profile').on(t.profileId), index('sessions_expires').on(t.expiresAt)]
);

export const profilePins = sqliteTable('profile_pins', {
	profileId: text('profile_id')
		.primaryKey()
		.references(() => profiles.id, { onDelete: 'cascade' }),
	hash: text('hash').notNull(),
	createdAt: text('created_at').notNull().default(now)
});
