// Per-module settings, stored as JSON in the meta table under `settings:<module key>` and parsed with
// the module's zod schema (defaults when missing or invalid). Secrets (tokens, passwords) live here
// too; a module never returns them from its API (it says `hasToken: true` instead).
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { DB } from './db';
import { meta } from './db/schema';
import { parse } from './validation';

export interface SettingsStore<T> {
	get(): T;
	/** Validates and saves; returns what was saved. Throws a 400 AppError on bad input. */
	set(input: unknown): T;
	/** The meta key. */
	key: string;
}

export function moduleSettings<T>(
	db: DB,
	moduleKey: string,
	schema: z.ZodType<T>,
	defaults: T
): SettingsStore<T> {
	const key = `settings:${moduleKey}`;
	return {
		key,
		get() {
			const row = db.select().from(meta).where(eq(meta.key, key)).get();
			if (!row) return structuredClone(defaults);
			try {
				const result = schema.safeParse(JSON.parse(row.value));
				return result.success ? result.data : structuredClone(defaults);
			} catch {
				return structuredClone(defaults);
			}
		},
		set(input) {
			const value = parse(schema, input) as T;
			db.insert(meta)
				.values({ key, value: JSON.stringify(value) })
				.onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } })
				.run();
			return value;
		}
	};
}
