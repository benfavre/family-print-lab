import { describe, expect, it } from 'vitest';
import { KID_LEVELS } from '$lib/shared/domain';
import { KID_TEMPLATES, smallPartsHazard } from '$lib/shared/kid';
import { cleanKidText, kidParams, renderKid } from './templates';

describe('kid templates', () => {
	const cases = KID_TEMPLATES.flatMap((t) =>
		KID_LEVELS.filter((l) => t.levels.includes(l)).flatMap((level) =>
			(['min', 'max'] as const).map((end) => ({ t, level, end }))
		)
	);

	it.each(cases.map((c) => [`${c.t.id} · ${c.level} · ${c.end}`, c] as const))(
		'%s renders within the level’s safety rules',
		async (_, { t, level, end }) => {
			const input: Record<string, unknown> = {};
			for (const c of t.controls) {
				if (c.kind === 'size') input[c.name] = c.range[level][end === 'min' ? 0 : 1];
				if (c.kind === 'choice')
					input[c.name] = c.options[end === 'min' ? 0 : c.options.length - 1].value;
				if (c.kind === 'text') input[c.name] = end === 'min' ? 'Al' : 'WWWWWWWWWWWWWW';
			}
			const r = await renderKid(t.id, level, input, 'Sam');
			expect(r.soup.length).toBeGreaterThan(0);
			expect(Math.max(...r.size)).toBeLessThanOrEqual(240); // fits the bed
			if (level === 'little') expect(r.smallParts).toBe(false);
		},
		60_000
	);

	it('clamps numbers, snaps to steps, rejects unknown choices and keys', () => {
		const sign = KID_TEMPLATES.find((t) => t.id === 'name-sign')!;
		const p = kidParams(
			sign,
			'little',
			{ wanted_letter: 3, shape: 'evil"); import("x', extra: 'hole', $fn: 1000, wall: 0 },
			'Léa'
		);
		expect(p).toEqual({
			name: 'Léa',
			wanted_letter: 16,
			shape: 'rounded',
			extra: 'hole',
			min_width: 70
		});
	});

	it('keeps text to plain letters and the level’s length', () => {
		expect(cleanKidText('  Zoé 🦄 "x"\\ \n <b>  ', 20)).toBe('Zoé x b');
		expect(cleanKidText('Maximilian', 8)).toBe('Maximili');
	});

	it('refuses templates meant for older makers', async () => {
		await expect(renderKid('keychain', 'little', {}, 'Sam')).rejects.toThrow(/older makers/);
	});

	it('flags parts that fit the small-parts cylinder', () => {
		expect(smallPartsHazard([30, 30, 4])).toBe(true);
		expect(smallPartsHazard([40, 35, 4])).toBe(false);
		expect(smallPartsHazard([20, 20, 60])).toBe(false);
	});
});
