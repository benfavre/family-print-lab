// Request shapes for the model API.
import { z } from 'zod';
import { AppError } from '../validation';
import { AI_PROVIDERS } from '$lib/shared/integrations';

const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const vec = (min: number, max: number) =>
	z.tuple([finite(min, max), finite(min, max), finite(min, max)]);
const axis = z.enum(['x', 'y', 'z']);
const source = z.string().max(200_000);
export const paramValues = z
	.record(z.string().max(80), z.union([z.string().max(1000), z.number().finite(), z.boolean()]))
	.default({});

export const createModel = z.strictObject({
	projectId: z.string().max(80),
	name: z.string().trim().min(1, 'Give the model a name.').max(80),
	source: source.optional(),
	origin: z.enum(['editor', 'ai']).default('editor'),
	note: z.string().trim().max(200).optional(),
	/** The AI design task this came from, so the Activity tray stops offering it. */
	taskId: z.string().max(80).optional()
});

export const preview = z.strictObject({ source, params: paramValues });
export const saveVersion = z.strictObject({
	source,
	params: paramValues,
	note: z.string().trim().max(200).optional(),
	origin: z.enum(['editor', 'ai']).default('editor'),
	/** The AI task whose suggestion this is, so the Activity tray stops offering it. */
	taskId: z.string().max(80).optional()
});
export const rename = z.strictObject({ name: z.string().max(80) });
export const restore = z.strictObject({ versionId: z.string().max(80) });

export const meshOp = z.discriminatedUnion('op', [
	z.strictObject({ op: z.literal('scale'), factor: vec(0.001, 1000) }),
	z.strictObject({ op: z.literal('rotate'), degrees: vec(-360, 360) }),
	z.strictObject({ op: z.literal('mirror'), axis }),
	z.strictObject({ op: z.literal('center') }),
	z.strictObject({ op: z.literal('autoOrient') }),
	z.strictObject({
		op: z.literal('text'),
		text: z.string().trim().min(1, 'Type some text.').max(60),
		font: z.enum(['bold', 'regular', 'mono']).default('bold'),
		size: finite(2, 200),
		depth: finite(0.2, 20),
		mode: z.enum(['emboss', 'engrave']),
		point: vec(-10_000, 10_000),
		normal: vec(-1, 1),
		angle: finite(-360, 360).default(0)
	}),
	z.strictObject({
		op: z.literal('copies'),
		count: z.number().int().min(2).max(36),
		gap: finite(0, 100).default(5)
	}),
	z.strictObject({ op: z.literal('layFlat'), normal: vec(-1, 1) }),
	z.strictObject({
		op: z.literal('cut'),
		axis,
		at: finite(-10_000, 10_000),
		keep: z.enum(['below', 'above', 'both'])
	}),
	z.strictObject({
		op: z.literal('drill'),
		x: finite(-10_000, 10_000),
		y: finite(-10_000, 10_000),
		diameter: finite(0.1, 500)
	}),
	z.strictObject({
		op: z.literal('combine'),
		mode: z.enum(['union', 'subtract', 'intersect']),
		otherModelId: z.string().max(80)
	})
]);

export const blenderAction = z.strictObject({
	action: z.enum(['repair', 'decimate', 'open']),
	ratio: finite(0.01, 1).default(0.5)
});

const image = z.unknown().optional();
const provider = z.enum(AI_PROVIDERS).optional();
export const design = z.strictObject({
	projectId: z.string().max(80),
	prompt: z.string().max(4000),
	image,
	provider
});
export const aiEdit = z.strictObject({
	source,
	instruction: z.string().max(4000),
	params: paramValues,
	image,
	provider
});

/** Reads a raw binary body with a size limit. */
export async function readBinary(request: Request, limit: number): Promise<Buffer> {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > limit)
		throw new AppError(413, `Files must be under ${Math.round(limit / 1_000_000)} MB.`);
	const buf = Buffer.from(await request.arrayBuffer());
	if (buf.length > limit)
		throw new AppError(413, `Files must be under ${Math.round(limit / 1_000_000)} MB.`);
	if (!buf.length) throw new AppError(400, 'The file is empty.');
	return buf;
}
