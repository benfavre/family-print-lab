import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildDatabase, collapse, type BuildInput } from './lib';
import type { HmsDatabaseFile } from '../../src/lib/shared/hms';

// Shapes as Bambu Studio v02.08.02.61 resources/hms and ha-bambulab 0e027ff hms_error_text have them.
const input: BuildInput = {
	language: 'en',
	bambu: [
		{
			device: '094',
			info: {
				ver: 202503231214,
				data: {
					device_hms: {
						ver: 202503231214,
						en: [
							{ ecode: '0700200000020001', intro: 'AMS A Slot 1 filament has run out (H2D).' },
							{ ecode: '0300100000020001', intro: '' }
						]
					},
					device_error: {
						ver: 202503231214,
						en: [
							{ ecode: '07008011', intro: 'AMS filament ran out.' },
							{ ecode: '0500C011', intro: '' },
							{ ecode: 'nothex!!', intro: 'skipped' }
						]
					}
				}
			},
			actions: {
				data: [
					{ ecode: '07008011', actions: [4, 6], image: 'aa.png', device: '094' },
					{ ecode: '07008011', actions: [9], image: '', device: 'default' },
					{ ecode: '03008016', actions: [4, 5, 6], image: '', device: 'default' },
					{ ecode: '0C00403D', actions: [6, 11], image: '', device: '22E' }
				]
			}
		},
		{
			device: '22E',
			info: {
				ver: 202510142200,
				data: {
					device_hms: {
						en: [{ ecode: '0700200000020001', intro: 'AMS A Slot 1 filament has run out.' }]
					},
					device_error: { en: [{ ecode: '07008011', intro: 'AMS filament ran out.' }] }
				}
			},
			actions: {
				data: [
					{ ecode: '03008016', actions: [4, 5, 6], image: 'bb.png', device: 'default' },
					{ ecode: '07008011', actions: [4, 6], image: 'aa.png', device: '22E' }
				]
			}
		}
	],
	ha: {
		device_hms: {
			'0700200000020001': {
				'AMS A Slot 1 filament has run out.': [],
				'AMS A Slot 1 filament has run out (X1).': ['X1C', 'X1']
			},
			'0300100000020001': { 'The resonance frequency of the X axis is low.': [] },
			'0300_0100_0001_0007': { 'Heatbed fault.': ['P1S', 'NOPE'] }
		},
		device_error: { '07008011': { 'AMS filament ran out (ha).': [] } }
	},
	wiki: {
		'0700200000020001': {
			'/en/x1/troubleshooting/hmscode/0700_2000_0002_0001': [],
			'/en/h2/troubleshooting/hmscode/0700_2000_0002_0001': ['H2D']
		},
		bad: { '/x': [] }
	},
	haDevices: { X1: '00M', X1C: '00M', P1S: '01P', H2D: '094' },
	devices: { '094': ['H2D'], '22E': ['P2S'], '00M': ['X1C', 'X1'], '01P': ['P1S'] },
	sources: [{ name: 'test', url: 'https://example.org', ref: 'x', licence: 'MIT', used: 'all' }],
	images: (name) => (name === 'aa.png' ? 'aa.webp' : null)
};

describe('buildDatabase', () => {
	it('merges Bambu Studio and ha-bambulab into the compact format (golden)', () => {
		const { file, unknownModels, imageNames } = buildDatabase(input);
		expect(unknownModels).toEqual(['NOPE']);
		expect(imageNames).toEqual(['aa.png', 'bb.png']);
		expect(file).toEqual({
			format: 1,
			version: '202510142200',
			language: 'en',
			sources: input.sources,
			devices: { '00M': ['X1C', 'X1'], '01P': ['P1S'], '094': ['H2D'], '22E': ['P2S'] },
			messages: [
				'',
				'AMS A Slot 1 filament has run out.',
				'AMS A Slot 1 filament has run out (X1).',
				'The resonance frequency of the X axis is low.',
				'Heatbed fault.',
				'AMS A Slot 1 filament has run out (H2D).',
				'AMS filament ran out (ha).',
				'AMS filament ran out.'
			],
			hms: {
				// An empty Bambu HMS text keeps ha-bambulab's.
				'0300010000010007': 4,
				'0300100000020001': 3,
				'0700200000020001': { '00M': 2, '094': 5, default: 1 }
			},
			errors: {
				// An empty print error text marks it internal.
				'0500C011': 0,
				'07008011': { '094': 7, '22E': 7, default: 6 }
			},
			wiki: {
				'0700200000020001': {
					'094': '/en/h2/troubleshooting/hmscode/0700_2000_0002_0001',
					default: '/en/x1/troubleshooting/hmscode/0700_2000_0002_0001'
				}
			},
			actions: {
				'03008016': { default: [4, 5, 6] },
				'07008011': { '094': [4, 6], '22E': [4, 6], default: [9] }
			},
			images: { '07008011': { '094': 'aa.webp', '22E': 'aa.webp' } }
		});
	});

	it('collapses per-device values', () => {
		expect(
			collapse(
				new Map([
					['a', 1],
					['b', 1]
				])
			)
		).toBe(1);
		expect(
			collapse(
				new Map([
					['a', 1],
					['b', 2],
					['c', 2]
				])
			)
		).toEqual({ a: 1, default: 2 });
		expect(collapse(new Map([['a', 1]]), 3)).toEqual({ a: 1, default: 3 });
		expect(collapse(new Map())).toBeNull();
	});
});

describe('the committed database', () => {
	const dir = path.resolve('resources/hms');
	const gz = fs.readFileSync(path.join(dir, 'hms-en.json.gz'));
	const file = JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as HmsDatabaseFile;

	it('stays small and names its sources', () => {
		expect(gz.length).toBeLessThan(1.5 * 1024 * 1024);
		expect(file.sources.map((s) => s.name)).toEqual(['Bambu Studio', 'ha-bambulab']);
		expect(fs.readFileSync(path.join(dir, 'SOURCES.md'), 'utf8')).toContain('v02.08.02.61');
	});

	it('has every picture it refers to', () => {
		for (const byDevice of Object.values(file.images))
			for (const name of Object.values(byDevice))
				expect(fs.existsSync(path.join(dir, 'images', name))).toBe(true);
	});

	it('knows the codes the simulator raises', () => {
		const text = (i: number) => file.messages[i];
		expect(text(file.hms['0700200000020001'] as number)).toMatch(
			/AMS A Slot 1 filament has run out/
		);
		expect(file.actions['07008011']['20P']).toEqual([4, 6]);
		expect(file.actions['03008016'].default).toEqual([4, 5, 6]);
		expect(Object.keys(file.devices).sort()).toEqual(
			[
				'00M',
				'01P',
				'01S',
				'030',
				'039',
				'03W',
				'093',
				'094',
				'20P',
				'22E',
				'239',
				'26A',
				'31B'
			].sort()
		);
	});
});
