// What the AI provider is asked: one camera picture plus the print's context, answered as strict JSON
// ({ verdict, confidence, reason }), validated before we believe it.
import { verdictSchema, type ProviderVerdict } from './validation';

export interface PrintContext {
	printerModel: string;
	/** The print's name as the printer reports it. */
	task: string;
	layer: number | null;
	totalLayers: number | null;
	percent: number | null;
	/** The filament type loaded in the active tray (PLA, PETG…), or null. */
	material: string | null;
	elapsedMinutes: number | null;
}

export const VISION_SYSTEM = [
	'You check pictures from the camera of a Bambu Lab 3D printer while it prints, for a family at home.',
	'Look for print failures only:',
	'- "spaghetti": loose strands or a tangle of filament in the air or on the bed instead of a solid part;',
	'- "detached": the part has come off the build plate, fallen over or moved;',
	'- "blob": a lump of melted plastic stuck around the nozzle or the part;',
	'- "ok": the print looks normal for its stage (a small or unfinished part is normal early on);',
	'- "unsure": the picture is too dark, blurry, blocked or unclear to tell.',
	'The toolhead, cables, purge lines, the poop chute and the build plate texture are normal.',
	'Be calm and careful: a false alarm stops a family print, so only say a failure with confidence',
	'above 0.8 when you can clearly see it. Answer in the JSON format asked for, with one or two short',
	'plain sentences as the reason.'
].join('\n');

/** The user message that goes with the picture. */
export function buildPrompt(c: PrintContext): string {
	const lines = [`Printer: ${c.printerModel}.`];
	if (c.task) lines.push(`Printing: ${c.task.slice(0, 120)}.`);
	if (c.layer !== null)
		lines.push(`Layer ${c.layer}${c.totalLayers ? ` of ${c.totalLayers}` : ''}.`);
	if (c.percent !== null) lines.push(`About ${Math.round(c.percent)} % done.`);
	if (c.material) lines.push(`Material: ${c.material}.`);
	if (c.elapsedMinutes !== null)
		lines.push(`Printing for ${Math.round(c.elapsedMinutes)} minutes.`);
	lines.push('Is this print going wrong? Look at the picture and answer.');
	return lines.join('\n');
}

/** The provider's answer, validated; a string that holds JSON is read too (some CLIs return text). */
export function parseVerdict(raw: unknown): ProviderVerdict {
	let value = raw;
	if (typeof value === 'string') {
		const text = value.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
		try {
			value = JSON.parse(text);
		} catch {
			throw new Error('The AI answered in a form the app could not read.');
		}
	}
	const result = verdictSchema.safeParse(value);
	if (!result.success) throw new Error('The AI answered in a form the app could not read.');
	return result.data;
}
