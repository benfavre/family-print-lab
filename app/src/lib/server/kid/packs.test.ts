import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db';
import { loadPacks, packTemplates, parsePacks, savePacks } from './packs';
import { renderKid } from './templates';
import { TEST_PACK } from '../__fixtures__/pack';

describe('template packs', () => {
	it('keeps only valid packs, and never lets one replace a built-in template', () => {
		expect(parsePacks('nope')).toEqual([]);
		expect(parsePacks([{ ...TEST_PACK, id: 'Bad ID' }])).toEqual([]);
		const tooBig = {
			...TEST_PACK,
			templates: [
				{
					...TEST_PACK.templates[0],
					controls: [
						{
							...TEST_PACK.templates[0].controls[0],
							range: { little: [40, 400], junior: [20, 60] }
						}
					]
				}
			]
		};
		expect(parsePacks([tooBig])).toEqual([]);
		const clash = { ...TEST_PACK, templates: [{ ...TEST_PACK.templates[0], id: 'name-sign' }] };
		expect(parsePacks([clash])).toEqual([]);
		expect(parsePacks([TEST_PACK])).toHaveLength(1);
	});

	it('renders pack templates with the kid mode rules, and survives a restart', async () => {
		const db = openDatabase(':memory:');
		savePacks(db, parsePacks([TEST_PACK]));
		expect(packTemplates()).toMatchObject([{ id: 'test-block', pack: 'test-pack' }]);
		expect(packTemplates()[0]).not.toHaveProperty('source');
		// Out-of-range sizes are clamped to the level's range, like the built-in templates.
		const little = await renderKid('test-block', 'little', { size: 5 }, 'Mia');
		expect(little.params.size).toBe(40);
		expect(little.size.map(Math.round)).toEqual([40, 40, 4]);
		savePacks(db, []);
		expect(packTemplates()).toEqual([]);
		savePacks(db, parsePacks([TEST_PACK]));
		expect(loadPacks(db)).toHaveLength(1);
		await expect(renderKid('test-block', 'junior', { size: 20 }, 'Mia')).resolves.toBeTruthy();
		savePacks(db, []);
		await expect(renderKid('test-block', 'junior', {}, 'Mia')).rejects.toThrow(/does not exist/);
	});
});
