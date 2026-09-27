import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HmsDatabase, loadHmsDatabase, pick } from './database';
import { WIKI_HOME, type HmsDatabaseFile } from '$lib/shared/hms';

const file: HmsDatabaseFile = {
	format: 1,
	version: '1',
	language: 'en',
	sources: [],
	devices: { '094': ['H2D'], '01P': ['P1S'] },
	messages: ['', 'Generic text.', 'H2D text.', 'Only text.', 'Print error.'],
	hms: {
		'0700200000020001': { '094': 2, default: 1 },
		'0300100000020001': 3,
		'0500040000020007': { '094': 2 }
	},
	errors: { '07008011': 4, '0500C011': 0 },
	wiki: {
		'0700200000020001': { '094': '/en/h2/x', default: '/en/x1/x' },
		'0300100000020001': '/en/x1/y'
	},
	actions: { '07008011': { '094': [4, 6], default: [9] } },
	images: { '07008011': { '094': 'a.webp' } }
};

describe('HmsDatabase lookups', () => {
	const db = new HmsDatabase(file);

	it('picks the device text, else the default, else nothing', () => {
		expect(db.text('hms', '0700200000020001', '094')).toBe('H2D text.');
		expect(db.text('hms', '0700200000020001', '01P')).toBe('Generic text.');
		expect(db.text('hms', '0700200000020001', null)).toBe('Generic text.');
		expect(db.text('hms', '0300100000020001', '094')).toBe('Only text.');
		// Device-specific only: other devices get nothing.
		expect(db.text('hms', '0500040000020007', '01P')).toBeNull();
		expect(db.text('hms', 'FFFFFFFFFFFFFFFF', '094')).toBeNull();
		expect(db.text('print_error', '07008011', '01P')).toBe('Print error.');
		// Bambu's internal marker.
		expect(db.text('print_error', '0500C011', '094')).toBe('');
	});

	it('links the device wiki page, else the generic page, else the HMS home', () => {
		expect(db.wikiUrl('hms', '0700200000020001', '094')).toBe('https://wiki.bambulab.com/en/h2/x');
		expect(db.wikiUrl('hms', '0700200000020001', '01P')).toBe('https://wiki.bambulab.com/en/x1/x');
		expect(db.wikiUrl('hms', '0300100000020001', '094')).toBe('https://wiki.bambulab.com/en/x1/y');
		expect(db.wikiUrl('hms', '0C0003000003000B', '094')).toBe(WIKI_HOME);
		expect(db.wikiUrl('print_error', '07008011', '094')).toBe(WIKI_HOME);
	});

	it('finds actions and pictures per device with Bambu’s "default" fallback', () => {
		expect(db.actions('07008011', '094')).toEqual([4, 6]);
		expect(db.actions('07008011', '01P')).toEqual([9]);
		expect(db.actions('03008016', '094')).toEqual([]);
		expect(db.image('07008011', '094')).toBe('a.webp');
		expect(db.image('07008011', '01P')).toBeNull();
		expect(pick({ a: 1 }, null)).toBeNull();
	});
});

describe('loadHmsDatabase', () => {
	it('falls back to English and to nothing', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-hms-'));
		try {
			expect(loadHmsDatabase('en', dir)).toBeNull();
			fs.writeFileSync(path.join(dir, 'hms-en.json.gz'), zlib.gzipSync(JSON.stringify(file)));
			const other = path.join(dir, 'x');
			fs.mkdirSync(other);
			fs.writeFileSync(path.join(other, 'hms-en.json.gz'), zlib.gzipSync(JSON.stringify(file)));
			// A language that is not shipped reads English.
			expect(loadHmsDatabase('de-DE', other)?.language).toBe('en');
			expect(loadHmsDatabase('en', other)?.text('hms', '0300100000020001', null)).toBe(
				'Only text.'
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('loads the committed database', () => {
		const db = loadHmsDatabase('en');
		expect(db?.text('print_error', '0300400C', '094')).toBe('The task was canceled.');
		expect(db?.knowsDevice('20P')).toBe(true);
	});
});
