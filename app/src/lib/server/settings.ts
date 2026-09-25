import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from './db';
import { meta } from './db/schema';
import { PROVIDERS } from './ai/providers';
import { parse } from './validation';

export const AI_TASKS = ['chat', 'ideas', 'diagnose', 'settings', 'checklist', 'cad'] as const;
export type AiTask = (typeof AI_TASKS)[number];
export const AI_TASK_LABEL: Record<AiTask, string> = {
	chat: 'Chat',
	ideas: 'Print ideas',
	diagnose: 'Failure diagnosis',
	settings: 'Slicer settings',
	checklist: 'Checklists',
	cad: 'Designing & editing models'
};

const provider = z.enum(PROVIDERS);
const settingsSchema = z.object({
	ai: z.object({
		routing: z.object(
			Object.fromEntries(AI_TASKS.map((t) => [t, provider])) as Record<AiTask, typeof provider>
		),
		models: z.object({
			'claude-code': z.string().max(60),
			codex: z.string().max(60),
			'anthropic-api': z.string().max(60)
		})
	})
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
	ai: {
		routing: {
			chat: 'claude-code',
			ideas: 'claude-code',
			diagnose: 'claude-code',
			settings: 'claude-code',
			checklist: 'claude-code',
			cad: 'claude-code'
		},
		models: { 'claude-code': 'opus', codex: '', 'anthropic-api': 'claude-opus-5' }
	}
};

export function getSettings(db: DB): Settings {
	const row = db.select().from(meta).where(eq(meta.key, 'settings')).get();
	if (!row) return structuredClone(DEFAULT_SETTINGS);
	const stored = settingsSchema.safeParse(JSON.parse(row.value));
	return stored.success ? stored.data : structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(db: DB, input: unknown): Settings {
	const next = parse(settingsSchema, input);
	db.insert(meta)
		.values({ key: 'settings', value: JSON.stringify(next) })
		.onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(next) } })
		.run();
	return next;
}
