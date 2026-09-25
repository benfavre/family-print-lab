import { z } from 'zod';
import type { DB } from './db';
import { activity, checklistItems, jobs, meta, profiles, projects, spools } from './db/schema';
import {
	CATEGORIES,
	JOB_STATUSES,
	KID_LEVELS,
	PROFILE_COLORS,
	PROJECT_STATUSES,
	type Workspace
} from '$lib/shared/domain';
import { AppError } from './validation';
import type { Lab } from './lab';
import { sql } from 'drizzle-orm';

export const EXPORT_FORMAT = 'family-print-lab';
export const EXPORT_VERSION = 2;

const str = (max = 4000) => z.string().max(max).catch('');
const num = z.number().finite().nullable().catch(null);
const iso = z
	.string()
	.max(40)
	.nullable()
	.catch(null)
	.transform((v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null));

// Lenient on optional fields (older files lack them), strict on identity and references.
const profile = z.object({
	id: z.string().min(1).max(80),
	name: z.string().trim().min(1).max(80),
	age: z.number().int().min(0).max(120).nullable().catch(null),
	color: z.enum(PROFILE_COLORS).catch('violet'),
	interests: str(500),
	kid: z.enum(KID_LEVELS).nullable().catch(null).optional(),
	createdAt: iso.optional()
});
const project = z.object({
	id: z.string().min(1).max(80),
	profileId: z.string().min(1).max(80),
	title: z.string().trim().min(1).max(80),
	status: z.enum(PROJECT_STATUSES).catch('Idea'),
	category: z.enum(CATEGORIES).catch('Home'),
	description: str(),
	notes: str(),
	url: str(1000),
	files: str(),
	material: str(1000),
	pinned: z.boolean().catch(false),
	checklist: z
		.array(
			z.object({
				id: z.string().max(80).optional(),
				text: z.string().trim().min(1).max(200),
				done: z.boolean().catch(false)
			})
		)
		.max(60)
		.catch([]),
	createdAt: iso.optional(),
	updatedAt: iso.optional()
});
const spool = z.object({
	id: z.string().min(1).max(80),
	brand: str(80),
	material: z.string().trim().min(1).max(40),
	colorName: str(80),
	colorHex: z.string().regex(/^#[0-9a-f]{6}$/i),
	totalGrams: z.number().positive().max(100_000),
	remainingGrams: z.number().min(0).max(100_000),
	cost: num,
	notes: str(1000),
	createdAt: iso.optional()
});
const job = z.object({
	id: z.string().min(1).max(80),
	projectId: z.string().min(1).max(80),
	status: z.enum(JOB_STATUSES).catch('Queued'),
	revision: str(80),
	spoolId: z
		.string()
		.max(80)
		.nullable()
		.catch(null)
		.transform((v) => v || null),
	material: str(80),
	grams: num,
	minutes: num,
	actualMinutes: num,
	layerHeight: str(20),
	nozzle: str(20),
	plate: str(60),
	supports: z.enum(['None', 'Normal', 'Tree']).catch('None'),
	infill: z.number().int().min(0).max(100).nullable().catch(null),
	notes: str(),
	printerTask: str(200),
	modelVersionId: z.unknown().optional(),
	// v2 fields, or v1's nested `charge: {spoolId, grams}`
	chargeSpoolId: z.string().max(80).nullable().optional(),
	chargeGrams: z.number().min(0).optional(),
	charge: z
		.object({ spoolId: z.string(), grams: z.number().min(0) })
		.nullable()
		.optional(),
	createdAt: iso.optional(),
	startedAt: iso.optional(),
	finishedAt: iso.optional()
});
const importFile = z.object({
	format: z.literal(EXPORT_FORMAT).optional(),
	version: z.number().optional(),
	profiles: z.array(profile).max(50),
	projects: z.array(project).max(5000),
	jobs: z.array(job).max(20000).default([]),
	spools: z.array(spool).max(500).default([])
});

export type ImportData = z.infer<typeof importFile>;

export function exportWorkspace(lab: Lab) {
	const { changeId: _changeId, ...data } = lab.snapshot();
	return {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		...data
	};
}

export function parseImport(input: unknown): ImportData {
	const result = importFile.safeParse(input);
	if (!result.success)
		throw new AppError(
			400,
			`That file is not a valid Family Print Lab backup: ${result.error.issues
				.slice(0, 3)
				.map((i) => `${i.path.join('.')} ${i.message}`)
				.join('; ')}`
		);
	const data = result.data;
	const ids = (list: { id: string }[], label: string) => {
		const seen = new Set<string>();
		for (const { id } of list) {
			if (seen.has(id)) throw new AppError(400, `Duplicate ${label} id “${id}” in the backup.`);
			seen.add(id);
		}
		return seen;
	};
	const people = ids(data.profiles, 'profile'),
		projectIds = ids(data.projects, 'project'),
		spoolIds = ids(data.spools, 'spool');
	ids(data.jobs, 'job');
	for (const p of data.projects)
		if (!people.has(p.profileId))
			throw new AppError(400, `Project “${p.title}” belongs to a missing family member.`);
	for (const j of data.jobs)
		if (!projectIds.has(j.projectId))
			throw new AppError(400, `A print job belongs to a missing project.`);
	for (const s of data.spools)
		if (s.remainingGrams > s.totalGrams)
			throw new AppError(400, `Spool “${s.colorName || s.id}” has more remaining than its size.`);
	for (const j of data.jobs) if (j.spoolId && !spoolIds.has(j.spoolId)) j.spoolId = null;
	return data;
}

/** Replaces the whole workspace with an import, atomically. */
export function replaceWorkspace(db: DB, lab: Lab, data: ImportData) {
	const now = new Date().toISOString();
	const spoolIds = new Set(data.spools.map((s) => s.id));
	db.transaction((tx) => {
		for (const table of [activity, jobs, checklistItems, projects, spools, profiles])
			tx.delete(table).run();
		if (data.profiles.length)
			tx.insert(profiles)
				.values(data.profiles.map((p) => ({ ...p, createdAt: p.createdAt ?? now, updatedAt: now })))
				.run();
		if (data.spools.length)
			tx.insert(spools)
				.values(data.spools.map((s) => ({ ...s, createdAt: s.createdAt ?? now, updatedAt: now })))
				.run();
		for (const p of data.projects) {
			const { checklist, ...row } = p;
			tx.insert(projects)
				.values({ ...row, createdAt: row.createdAt ?? now, updatedAt: row.updatedAt ?? now })
				.run();
			if (checklist.length)
				tx.insert(checklistItems)
					.values(
						checklist.map((c, position) => ({
							id: crypto.randomUUID(),
							projectId: p.id,
							text: c.text,
							done: c.done,
							position
						}))
					)
					.run();
		}
		for (const j of data.jobs) {
			// Model files are not part of JSON exports, so links to model versions are dropped on import.
			const { charge, chargeSpoolId, chargeGrams, modelVersionId: _modelVersionId, ...row } = j;
			const chargeSpool = chargeSpoolId ?? charge?.spoolId ?? null;
			tx.insert(jobs)
				.values({
					...row,
					chargeSpoolId: chargeSpool && spoolIds.has(chargeSpool) ? chargeSpool : null,
					chargeGrams:
						chargeSpool && spoolIds.has(chargeSpool) ? (chargeGrams ?? charge?.grams ?? 0) : 0,
					createdAt: row.createdAt ?? now,
					startedAt: row.startedAt ?? null,
					finishedAt: row.finishedAt ?? null,
					updatedAt: now
				})
				.run();
		}
		tx.insert(activity)
			.values({
				kind: 'import',
				message: `Workspace restored from a backup (${data.projects.length} projects, ${data.jobs.length} jobs)`,
				at: now
			})
			.run();
		tx.insert(meta)
			.values({ key: 'change_id', value: '1' })
			.onConflictDoUpdate({
				target: meta.key,
				set: { value: sql`CAST(${meta.value} AS INTEGER) + 1` }
			})
			.run();
	});
	lab.events.emit('change', { changeId: lab.changeId(), kind: 'import' });
}

export type { Workspace };
