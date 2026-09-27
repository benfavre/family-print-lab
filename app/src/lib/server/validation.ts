import { z } from 'zod';
import {
	CATEGORIES,
	JOB_STATUSES,
	KID_LEVELS,
	PROFILE_COLORS,
	PROJECT_STATUSES,
	SUPPORTS
} from '$lib/shared/domain';
import { MODEL_CODES } from '$lib/shared/printers/models';

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

/** Patches keep every field optional without defaults: zod 4 applies a field's default even inside `.partial()`, which would reset every field a patch leaves out. */
function patchOf<T extends z.ZodRawShape>(shape: T) {
	const fields = Object.fromEntries(
		Object.entries(shape).map(([key, field]) => [
			key,
			((field instanceof z.ZodDefault ? field.unwrap() : field) as z.ZodType).optional()
		])
	);
	return z.strictObject(fields) as unknown as z.ZodObject<{
		[K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer U> ? U : T[K]>;
	}>;
}

export const profileInput = z.strictObject({
	name: required(80),
	age: z.number().int().min(0).max(120).nullable().default(null),
	color: z.enum(PROFILE_COLORS),
	interests: text(500).default(''),
	kid: z.enum(KID_LEVELS).nullable().default(null)
});
export const profilePatch = patchOf(profileInput.shape).extend({ version });

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
export const projectPatch = patchOf(projectInput.omit({ checklist: true }).shape).extend({
	version
});

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
	/** The printer to print on; null means any printer. */
	printerId: z.string().max(80).nullable(),
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

// ---------- Printers (Settings → Printers) ----------

const hostname = z
	.string()
	.trim()
	.min(1, 'Required')
	.max(253)
	.refine(
		(h) =>
			/^(\d{1,3}\.){3}\d{1,3}$/.test(h)
				? h.split('.').every((n) => Number(n) <= 255)
				: /^\[?[0-9a-f:]+\]?$/i.test(h) && h.includes(':')
					? true
					: /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
							h
						),
		'Use an IP address (like 192.168.1.20) or a host name.'
	);
const port = z.number().int().min(1).max(65535);
const printerFields = {
	name: required(60),
	model: z.enum(MODEL_CODES),
	host: hostname,
	serial: z
		.string()
		.trim()
		.regex(/^[A-Z0-9-]{4,32}$/i, 'The serial number is 4–32 letters and digits.')
		.transform((s) => s.toUpperCase()),
	accessCode: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9]{8}$/, 'The access code is 8 letters or digits (on the printer’s screen).'),
	port,
	ftpPort: port,
	tls: z.boolean(),
	simulated: z.boolean(),
	enabled: z.boolean()
};
export const printerInput = z.strictObject({
	...printerFields,
	port: port.default(8883),
	ftpPort: port.default(990),
	tls: z.boolean().default(true),
	simulated: z.boolean().default(false),
	enabled: z.boolean().default(true)
});
export const printerPatch = z
	.strictObject({ ...printerFields, accessCode: printerFields.accessCode.or(z.literal('')) })
	.partial()
	.extend({ version });
export const printerReorder = z.strictObject({ ids: z.array(z.string().max(80)).max(100) });
/** Test a connection: a new printer's details, or a saved one's (`id`) with changes; the stored access code is used when none is given. */
export const printerTest = z.strictObject({
	...printerFields,
	accessCode: printerFields.accessCode.or(z.literal('')).optional(),
	port: port.default(8883),
	ftpPort: port.default(990),
	tls: z.boolean().default(true),
	simulated: z.boolean().default(false),
	enabled: z.boolean().optional(),
	name: required(60).optional(),
	id: z.string().max(80).optional(),
	version: version.optional()
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
