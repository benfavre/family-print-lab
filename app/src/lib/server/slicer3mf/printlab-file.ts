// Metadata/print_lab.json: the app's own facts about a project that a 3MF has no place for (which AMS
// tray and spool each filament uses, which nozzle, and whether a preset is a system or user preset).
// Bambu Studio and OrcaSlicer skip files they do not know, and drop this one when they save.
import { z } from 'zod';
import type { FilamentSlot, PresetRef, PresetSelection, Project } from '$lib/shared/slicer/project';

export const PRINT_LAB_FORMAT = 1;

const presetRef = z.object({
	kind: z.enum(['printer', 'process', 'filament']),
	name: z.string(),
	source: z.enum(['system', 'user', 'project']),
	userPresetId: z.string().optional()
});
const schema = z.object({
	format: z.literal(PRINT_LAB_FORMAT),
	presets: z
		.object({
			printer: presetRef.optional(),
			process: presetRef.optional(),
			filaments: z.array(presetRef.nullable()).optional()
		})
		.optional(),
	filaments: z
		.array(
			z
				.object({
					tray: z.number().int().nullable().optional(),
					spoolId: z.string().nullable().optional(),
					nozzle: z
						.union([z.literal(0), z.literal(1)])
						.nullable()
						.optional()
				})
				.nullable()
		)
		.optional()
});

export interface PrintLabFile {
	presets?: { printer?: PresetRef; process?: PresetRef; filaments?: (PresetRef | undefined)[] };
	filaments?: (Pick<FilamentSlot, 'tray' | 'spoolId' | 'nozzle'> | undefined)[];
}

/** Null when absent or not ours. */
export function parsePrintLabFile(text: string | null): PrintLabFile | null {
	if (!text) return null;
	try {
		const r = schema.safeParse(JSON.parse(text));
		if (!r.success) return null;
		return {
			presets: r.data.presets && {
				printer: r.data.presets.printer,
				process: r.data.presets.process,
				filaments: r.data.presets.filaments?.map((f) => f ?? undefined)
			},
			filaments: r.data.filaments?.map((f) => f ?? undefined)
		};
	} catch {
		return null;
	}
}

const plain = (ref: PresetRef) => ref.source === 'project' && !ref.userPresetId;

/** The file's text, or null when there is nothing the 3MF itself does not already say. */
export function printLabFile(project: Project): string | null {
	const p: PresetSelection = project.presets;
	const refs = [p.printer, p.process, ...p.filaments];
	const extras = project.filaments.map((f) =>
		f.tray !== undefined || f.spoolId !== undefined || f.nozzle !== undefined
			? { tray: f.tray, spoolId: f.spoolId, nozzle: f.nozzle }
			: null
	);
	if (refs.every(plain) && extras.every((e) => e === null)) return null;
	return (
		JSON.stringify(
			{
				format: PRINT_LAB_FORMAT,
				presets: {
					printer: p.printer,
					process: p.process,
					filaments: project.filaments.map((f) => f.preset)
				},
				filaments: extras
			},
			null,
			2
		) + '\n'
	);
}
