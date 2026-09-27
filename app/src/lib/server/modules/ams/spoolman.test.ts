import { afterEach, describe, expect, it } from 'vitest';
import { fakeSpoolman } from './fake-spoolman';
import { SpoolmanClient, shelfSpoolFrom, spoolmanBase, spoolmanRemaining } from './spoolman';

const closers: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of closers.splice(0)) await c();
});

describe('Spoolman client', () => {
	it('checks the address', () => {
		expect(spoolmanBase('http://nas.local:7912/')).toBe('http://nas.local:7912');
		expect(spoolmanBase(' https://x.example/spoolman/ ')).toBe('https://x.example/spoolman');
		expect(() => spoolmanBase('ftp://x')).toThrow(/http/);
		expect(() => spoolmanBase('http://me:pw@x')).toThrow(/user name/);
		expect(() => spoolmanBase('nope')).toThrow(/web address/);
	});

	it('lists spools, records usage with the token, and reads Spoolman errors', async () => {
		const fake = await fakeSpoolman();
		closers.push(fake.close);
		const client = new SpoolmanClient(fake.url, 'secret');
		expect(await client.info()).toEqual({ version: '0.22.1' });
		expect((await client.spools()).map((s) => s.id)).toEqual([7, 8, 9]);
		await client.use(7, 12.5);
		expect(fake.used).toEqual([{ id: 7, grams: 12.5, auth: 'Bearer secret' }]);
		await expect(client.use(99, 1)).rejects.toThrow(/404: Spool not found/);
		await expect(new SpoolmanClient('http://127.0.0.1:1').info()).rejects.toThrow(/did not answer/);
	});

	it('turns Spoolman spools into shelf spools', async () => {
		const fake = await fakeSpoolman();
		closers.push(fake.close);
		const [a, b] = fake.spools;
		expect(shelfSpoolFrom(a as never)).toEqual({
			brand: 'Polymaker',
			material: 'PLA',
			colorName: 'Galaxy Black',
			colorHex: '#1a1a2e',
			totalGrams: 1000,
			remainingGrams: 640,
			notes: ''
		});
		expect(shelfSpoolFrom(b as never)).toMatchObject({
			material: 'PETG',
			colorHex: '#ff0000',
			colorName: 'Red',
			totalGrams: 750,
			remainingGrams: 700
		});
		expect(spoolmanRemaining(b as never)).toBe(700);
		expect(spoolmanRemaining({ id: 1, filament: { id: 1 }, used_weight: 3 })).toBeNull();
	});
});
