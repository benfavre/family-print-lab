// The AI check's pure rules: when a check is due, when an answer alerts or pauses, what the provider
// is asked and how its answer is read.
import { describe, expect, it } from 'vitest';
import { VISION_SETTINGS_DEFAULTS } from '$lib/shared/vision';
import { buildPrompt, parseVerdict } from './prompt';
import { activeFor, checkDue, decide, newWatch, REALERT_MS } from './schedule';
import { verdictSchema, visionSettingsSchema, VERDICT_JSON_SCHEMA } from './validation';

const MIN = 60_000;
const every = (everyLayers: number | null, everyMinutes: number | null) => ({
	everyLayers,
	everyMinutes
});

describe('checkDue', () => {
	it('takes the first picture once the first layer is done', () => {
		const w = newWatch('box', 0);
		expect(checkDue(w, every(20, 10), 1, 1000)).toBe(false);
		expect(checkDue(w, every(20, 10), 2, 1000)).toBe(true);
		// Seen for the first time late in a print (after a restart): check straight away.
		expect(checkDue(w, every(20, 10), 150, 1000)).toBe(true);
	});

	it('then checks every N layers', () => {
		const w = { ...newWatch('box', 0), lastAt: 0, lastLayer: 2, hasReference: true };
		expect(checkDue(w, every(20, null), 21, MIN)).toBe(false);
		expect(checkDue(w, every(20, null), 22, MIN)).toBe(true);
	});

	it('and/or every M minutes, whichever comes first', () => {
		const w = { ...newWatch('box', 0), lastAt: 0, lastLayer: 2, hasReference: true };
		expect(checkDue(w, every(20, 10), 5, 9 * MIN)).toBe(false);
		expect(checkDue(w, every(20, 10), 5, 10 * MIN)).toBe(true);
		expect(checkDue(w, every(null, 10), 500, 5 * MIN)).toBe(false);
	});

	it('falls back to minutes when the printer reports no layer', () => {
		const w = newWatch('box', 0);
		expect(checkDue(w, every(20, 10), null, 5 * MIN)).toBe(false);
		expect(checkDue(w, every(20, 10), null, 10 * MIN)).toBe(true);
		expect(checkDue(w, every(20, null), null, 60 * MIN)).toBe(false);
	});

	it('never checks by schedule when both are off', () => {
		const w = { ...newWatch('box', 0), lastAt: 0, lastLayer: 2, hasReference: true };
		expect(checkDue(w, every(null, null), 900, 900 * MIN)).toBe(false);
	});
});

describe('activeFor', () => {
	it('needs the global switch and not the printer switched off', () => {
		const s = { ...VISION_SETTINGS_DEFAULTS };
		expect(activeFor(s, 'p1')).toBe(false);
		expect(activeFor({ ...s, enabled: true }, 'p1')).toBe(true);
		expect(activeFor({ ...s, enabled: true, printers: { p1: false } }, 'p1')).toBe(false);
		expect(activeFor({ ...s, enabled: true, printers: { p1: false } }, 'p2')).toBe(true);
	});
});

describe('decide', () => {
	const s = { threshold: 0.75, autoPause: false };
	it('alerts on a sure enough problem only', () => {
		expect(decide({ verdict: 'spaghetti', confidence: 0.8 }, s, null, 0)).toEqual({
			alert: true,
			pause: false
		});
		expect(decide({ verdict: 'spaghetti', confidence: 0.7 }, s, null, 0).alert).toBe(false);
		expect(decide({ verdict: 'ok', confidence: 0.99 }, s, null, 0).alert).toBe(false);
		expect(decide({ verdict: 'unsure', confidence: 0.99 }, s, null, 0).alert).toBe(false);
		expect(decide({ verdict: 'blob', confidence: 0.9, error: 'x' }, s, null, 0).alert).toBe(false);
	});

	it('does not alert again for the same print within 15 minutes', () => {
		const w = { alertedAt: 0 };
		expect(decide({ verdict: 'detached', confidence: 0.9 }, s, w, REALERT_MS - 1).alert).toBe(
			false
		);
		expect(decide({ verdict: 'detached', confidence: 0.9 }, s, w, REALERT_MS).alert).toBe(true);
	});

	it('pauses only when asked to, and a pause is always told', () => {
		const pause = { ...s, autoPause: true };
		expect(decide({ verdict: 'spaghetti', confidence: 0.9 }, pause, { alertedAt: 0 }, 1)).toEqual({
			alert: true,
			pause: true
		});
		expect(decide({ verdict: 'spaghetti', confidence: 0.6 }, pause, null, 0).pause).toBe(false);
	});
});

describe('prompt', () => {
	it('gives the print’s context', () => {
		const text = buildPrompt({
			printerModel: 'Bambu Lab A1 mini',
			task: 'pencil_rocket_v01',
			layer: 42,
			totalLayers: 180,
			percent: 23.4,
			material: 'PLA',
			elapsedMinutes: 17.8
		});
		expect(text).toContain('Printer: Bambu Lab A1 mini.');
		expect(text).toContain('Printing: pencil_rocket_v01.');
		expect(text).toContain('Layer 42 of 180.');
		expect(text).toContain('About 23 % done.');
		expect(text).toContain('Material: PLA.');
		expect(text).toContain('Printing for 18 minutes.');
	});

	it('leaves out what it does not know', () => {
		const text = buildPrompt({
			printerModel: 'Bambu Lab X1 Carbon',
			task: '',
			layer: null,
			totalLayers: null,
			percent: null,
			material: null,
			elapsedMinutes: null
		});
		expect(text).not.toMatch(/Layer|Material|Printing/);
	});
});

describe('parseVerdict', () => {
	it('accepts the strict answer, as an object or as JSON text', () => {
		const answer = {
			verdict: 'spaghetti',
			confidence: 0.91,
			reason: 'Loose strands above the bed.'
		};
		expect(parseVerdict(answer)).toEqual(answer);
		expect(parseVerdict(JSON.stringify(answer))).toEqual(answer);
		expect(parseVerdict('```json\n' + JSON.stringify(answer) + '\n```')).toEqual(answer);
	});

	it('refuses anything else', () => {
		for (const bad of [
			{ verdict: 'fire', confidence: 0.9, reason: 'x' },
			{ verdict: 'ok', confidence: 1.4, reason: 'x' },
			{ verdict: 'ok', confidence: 0.5, reason: '' },
			{ verdict: 'ok' },
			'not json',
			null
		])
			expect(() => parseVerdict(bad), JSON.stringify(bad)).toThrow(/could not read/);
	});

	it('asks providers for the same shape it validates', () => {
		const props = VERDICT_JSON_SCHEMA.properties as Record<string, { enum?: string[] }>;
		expect(props.verdict.enum).toEqual(verdictSchema.shape.verdict.options);
		expect(VERDICT_JSON_SCHEMA.required).toEqual(['verdict', 'confidence', 'reason']);
	});
});

describe('settings', () => {
	it('keeps the defaults off and valid', () => {
		expect(visionSettingsSchema.parse(VISION_SETTINGS_DEFAULTS)).toEqual(VISION_SETTINGS_DEFAULTS);
		expect(VISION_SETTINGS_DEFAULTS).toMatchObject({
			enabled: false,
			method: 'local',
			autoPause: false
		});
	});

	it('refuses an unknown method or a threshold out of range', () => {
		expect(
			visionSettingsSchema.safeParse({ ...VISION_SETTINGS_DEFAULTS, method: 'gpt' }).success
		).toBe(false);
		expect(
			visionSettingsSchema.safeParse({ ...VISION_SETTINGS_DEFAULTS, threshold: 0.2 }).success
		).toBe(false);
	});
});
