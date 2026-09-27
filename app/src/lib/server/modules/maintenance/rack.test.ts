import { describe, expect, it } from 'vitest';
import h2c from '$lib/server/printer/sim/states/O1C2.json';
import x2d from '$lib/server/printer/sim/states/N6.json';
import { parseRack } from './rack';

describe('the H2C hotend rack', () => {
	it('lists the rack nozzles (ids 0x10–0x1F) by position, with the holder state', () => {
		const rack = parseRack(h2c.print);
		expect(rack).toMatchObject({ status: 'Idle', position: 'Centre' });
		expect(rack!.nozzles.map((n) => [n.slot, n.diameter, n.type])).toEqual([
			[0, 0.2, 'HS00'],
			[1, 0.4, 'HS01'],
			[2, 0.6, 'HS01'],
			[3, 0.4, 'HS01'],
			[5, 0.4, 'HS01']
		]);
		expect(rack!.nozzles[1].color).toBe('#00ae42');
		expect(rack!.nozzles[0].color).toBeNull();
	});

	it('is absent on printers without one', () => {
		expect(parseRack(x2d.print)).toBeNull();
		expect(parseRack({})).toBeNull();
		expect(parseRack(null)).toBeNull();
	});
});
