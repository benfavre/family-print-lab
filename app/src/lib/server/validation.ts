import { z } from 'zod';
import {
	CATEGORIES,
	JOB_STATUSES,
	KID_LEVELS,
	PROFILE_COLORS,
	PROJECT_STATUSES,
	SUPPORTS
} from '$lib/shared/domain';

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1, 'Required').max(max);
const grams = z.number().finite().min(0).max(100_000);
const optionalNumber = (max: number) => z.number().finite().min(0).max(max).nullable();
const isoOrNull = z.iso.datetime({ offset: true }).nullable();
const httpUrl = z.union([
	z.literal(''),
	z
		.url({ protocol: /^https?$/, error: 'Model links must start with https:// or http://.' })
		.max(1000)
]);

export const version = z.number().int().positive();

export const profileInput = z.strictObject({
	name: required(80),
	age: z.number().int().min(0).max(120).nullable().default(null),
	color: z.enum(PROFILE_COLORS),
	interests: text(500).default(''),
	kid: z.enum(KID_LEVELS).nullable().default(null)
});
export const profilePatch = profileInput.partial().extend({ version });

export const checklistStep = z.strictObject({
	text: required(200),
	done: z.boolean().default(false)
});

export const projectInput = z.strictObject({
	profileId: required(80),
	title: required(80),
	status: z.enum(PROJECT_STATUSES).default('Idea'),
	category: z.enum(CATEGORIES).default('Home'),
	description: text(4000).default(''),
	notes: text(4000).default(''),
	url: httpUrl.default(''),
	files: text(4000).default(''),
	material: text(1000).default(''),
	pinned: z.boolean().default(false),
	checklist: z.array(checklistStep).max(60).optional()
});
export const projectPatch = projectInput.omit({ checklist: true }).partial().extend({ version });

export const spoolInput = z
	.strictObject({
		brand: text(80).default(''),
		material: required(40),
		colorName: text(80).default(''),
		colorHex: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a #rrggbb color.'),
		totalGrams: z.number().finite().positive().max(100_000),
		remainingGrams: grams,
		cost: optionalNumber(100_000).default(null),
		notes: text(1000).default('')
	})
	.refine((s) => s.remainingGrams <= s.totalGrams, {
		message: 'Remaining weight cannot exceed the spool size.',
		path: ['remainingGrams']
	});
export const spoolPatch = z
	.strictObject({
		brand: text(80),
		material: required(40),
		colorName: text(80),
		colorHex: z.string().regex(/^#[0-9a-f]{6}$/i),
		totalGrams: z.number().finite().positive().max(100_000),
		remainingGrams: grams,
		cost: optionalNumber(100_000),
		notes: text(1000)
	})
	.partial()
	.extend({ version });

const jobShape = z.strictObject({
	projectId: required(80),
	status: z.enum(JOB_STATUSES),
	revision: text(80),
	spoolId: z.string().max(80).nullable(),
	material: text(80),
	grams: optionalNumber(20_000),
	minutes: optionalNumber(100_000),
	actualMinutes: optionalNumber(100_000),
	layerHeight: text(20),
	nozzle: text(20),
	plate: text(60),
	supports: z.enum(SUPPORTS),
	infill: z.number().int().min(0).max(100).nullable(),
	notes: text(4000),
	printerTask: text(200),
	modelVersionId: z.string().max(80).nullable(),
	startedAt: isoOrNull,
	finishedAt: isoOrNull
});
/** New jobs: only the project is required; the service fills sensible defaults. */
export const jobInput = jobShape.partial().required({ projectId: true });
export const jobPatch = jobShape
	.omit({ projectId: true })
	.partial()
	.extend({ version, projectId: required(80).optional() });
/** One change for many projects at once (the home grid's selection bar). */
export const projectBulk = z.strictObject({
	ids: z.array(z.string().max(80)).min(1, 'Select at least one project.').max(1000),
	action: z.enum(['status', 'owner', 'category', 'pin', 'unpin', 'duplicate', 'delete']),
	value: z.string().max(80).optional()
});
export const jobTransition = z.strictObject({
	to: z.enum(JOB_STATUSES),
	printerTask: text(200).optional(),
	/** The status the caller saw; refused when the job has moved on since. */
	from: z.enum(JOB_STATUSES).optional()
});

/** A grown-up's answer to a child's print request. */
export const requestDecision = z.strictObject({
	decision: z.enum(['approve', 'decline']),
	reply: text(300).default(''),
	version
});
export const printRequestInput = z.strictObject({
	spoolId: z.string().max(80).nullable().default(null),
	message: text(200).default('')
});

export const checklistPatch = z.strictObject({
	text: required(200).optional(),
	done: z.boolean().optional()
});
export const checklistReplace = z.strictObject({
	steps: z.array(required(200)).max(60),
	mode: z.enum(['replace', 'append'])
});

export type ProfileInput = z.infer<typeof profileInput>;
export type ProjectInput = z.infer<typeof projectInput>;
export type ProjectPatch = z.infer<typeof projectPatch>;
export type SpoolInput = z.infer<typeof spoolInput>;
export type SpoolPatch = z.infer<typeof spoolPatch>;
export type JobInput = z.infer<typeof jobInput>;
export type JobPatch = z.infer<typeof jobPatch>;

/** Parses input or throws a 400 AppError with readable messages. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	const message = result.error.issues
		.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
		.join('; ');
	throw new AppError(400, message);
}

export class AppError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}
