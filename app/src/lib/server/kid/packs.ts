// Template packs from Print Lab Cloud (Family plan): more kid mode templates, delivered as data
// (descriptions plus OpenSCAD sources). They are checked strictly here, rendered in the same sandbox
// and with the same safety rules as the built-in templates (values clamped to the level's range,
// plain text only, size limits, the small-parts test for little makers), and removed when the plan
// ends. Things already made from them are kept.
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { DB } from '../db';
import { meta } from '../db/schema';
import { KID_LEVELS } from '$lib/shared/domain';
import { KID_TEMPLATES, type KidTemplate } from '$lib/shared/kid';

const KEY = 'kid_packs';
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
const label = (max: number) => z.string().trim().min(1).max(max);
const levels = z.array(z.enum(KID_LEVELS)).min(1);
const perLevel = <T extends z.ZodTypeAny>(t: T) => z.object({ little: t, junior: t });
const range = z
	.tuple([z.number().min(5).max(240), z.number().min(5).max(240)])
	.refine(([a, b]) => a <= b);
const choice = z.object({
	value: z.string().regex(/^[a-z0-9-]{1,30}$/),
	label: label(40),
	icon: z.string().max(12)
});
const control = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('text'),
		name: z.string().regex(/^[a-z_]{1,30}$/),
		label: label(80),
		placeholder: z.string().max(40),
		max: perLevel(z.number().int().min(1).max(30))
	}),
	z.object({
		kind: z.literal('size'),
		name: z.string().regex(/^[a-z_]{1,30}$/),
		label: label(80),
		ends: z.tuple([label(20), label(20)]),
		step: z.number().positive().max(20),
		range: perLevel(range)
	}),
	z.object({
		kind: z.literal('choice'),
		name: z.string().regex(/^[a-z_]{1,30}$/),
		label: label(80),
		options: z.array(choice).min(2).max(8)
	})
]);
const template = z.object({
	id,
	title: label(40),
	blurb: label(160),
	icon: z.string().max(12),
	levels,
	controls: z.array(control).min(1).max(6),
	defaults: z.record(z.string(), z.union([z.string().max(40), z.number()])),
	source: z.string().min(20).max(40_000)
});
export const packSchema = z.object({
	id,
	title: label(40),
	blurb: label(200),
	icon: z.string().max(12),
	templates: z.array(template).min(1).max(20)
});
export type Pack = z.infer<typeof packSchema>;

/** Installed packs; templates.ts asks here for anything that is not built in. */
let installed: Pack[] = [];

export function loadPacks(db: DB) {
	const row = db.select().from(meta).where(eq(meta.key, KEY)).get();
	installed = row ? parsePacks(JSON.parse(row.value)) : [];
	return installed;
}

/** Keeps only valid packs, and never lets a pack replace a built-in template or another pack's. */
export function parsePacks(input: unknown): Pack[] {
	const taken = new Set(KID_TEMPLATES.map((t) => t.id));
	const out: Pack[] = [];
	for (const raw of Array.isArray(input) ? input : []) {
		const parsed = packSchema.safeParse(raw);
		if (!parsed.success) continue;
		const templates = parsed.data.templates.filter((t) => !taken.has(t.id));
		for (const t of templates) taken.add(t.id);
		if (templates.length) out.push({ ...parsed.data, templates });
	}
	return out;
}

export function savePacks(db: DB, packs: Pack[]) {
	installed = packs;
	const value = JSON.stringify(packs);
	db.insert(meta)
		.values({ key: KEY, value })
		.onConflictDoUpdate({ target: meta.key, set: { value } })
		.run();
}

export const installedPacks = () => installed;

/** What the kid pages show (no sources). */
export const packTemplates = (): KidTemplate[] =>
	installed.flatMap((p) => p.templates.map(({ source: _, ...t }) => ({ ...t, pack: p.id })));

export const packSource = (templateId: string) =>
	installed.flatMap((p) => p.templates).find((t) => t.id === templateId)?.source ?? null;
