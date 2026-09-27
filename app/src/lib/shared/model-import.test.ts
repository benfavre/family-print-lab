import { describe, expect, it } from 'vitest';
import {
	classifyLicence,
	creditText,
	fileFormat,
	parseModelLink,
	plainText,
	withCredit
} from './model-import';

describe('parseModelLink', () => {
	it('recognises Printables links, with or without a language or slug', () => {
		for (const url of [
			'https://www.printables.com/model/3161-3d-benchy',
			'https://printables.com/model/3161',
			'https://www.printables.com/de/model/3161-3d-benchy/files',
			'https://www.printables.com/model/3161-3d-benchy?lang=en#preview'
		])
			expect(parseModelLink(url)).toEqual({
				site: 'printables',
				id: '3161',
				url: 'https://www.printables.com/model/3161'
			});
	});

	it('recognises Thingiverse links', () => {
		expect(parseModelLink('https://www.thingiverse.com/thing:763622/files')).toEqual({
			site: 'thingiverse',
			id: '763622',
			url: 'https://www.thingiverse.com/thing:763622'
		});
		expect(parseModelLink(' http://thingiverse.com/thing:1 ')?.id).toBe('1');
	});

	it('recognises MakerWorld links and keeps the slug', () => {
		expect(
			parseModelLink('https://makerworld.com/en/models/2344501-snap-keyring#profileId-1')
		).toEqual({
			site: 'makerworld',
			id: '2344501',
			url: 'https://makerworld.com/en/models/2344501-snap-keyring'
		});
		expect(parseModelLink('https://makerworld.com/models/12')?.url).toBe(
			'https://makerworld.com/en/models/12'
		);
	});

	it('refuses other sites, look-alikes and other schemes', () => {
		for (const url of [
			'',
			'not a link',
			'https://evil.com/model/3161',
			'https://printables.com.evil.com/model/3161',
			'https://www.printables.com/social/123',
			'ftp://www.thingiverse.com/thing:1',
			'https://www.thingiverse.com/thing:abc',
			'https://makerworld.com.cn/zh/models/1',
			'javascript:alert(1)'
		])
			expect(parseModelLink(url)).toBeNull();
	});
});

describe('classifyLicence', () => {
	it('reads Printables names and abbreviations', () => {
		const nc = classifyLicence('CC-BY-NC-SA');
		expect(nc).toMatchObject({
			code: 'CC BY-NC-SA',
			commercial: false,
			remix: true,
			shareAlike: true,
			caution: true,
			url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
		});
		expect(
			classifyLicence('Creative Commons — Attribution  — Noncommercial  —  Share Alike').code
		).toBe('CC BY-NC-SA');
		expect(classifyLicence('CC0')).toMatchObject({ code: 'CC0', commercial: true, caution: false });
	});

	it('reads Thingiverse names', () => {
		expect(classifyLicence('Creative Commons - Attribution - No Derivatives')).toMatchObject({
			code: 'CC BY-ND',
			remix: false,
			commercial: true,
			caution: true
		});
		expect(classifyLicence('Creative Commons - Attribution - Non-Commercial').code).toBe(
			'CC BY-NC'
		);
		expect(classifyLicence('Creative Commons - Public Domain Dedication').code).toBe('CC0');
		expect(classifyLicence('GNU - GPL').code).toBe('GNU GPL');
		expect(classifyLicence('GNU - LGPL').code).toBe('GNU LGPL');
		expect(classifyLicence('BSD License').code).toBe('BSD');
		expect(classifyLicence('Creative Commons - Attribution')).toMatchObject({
			code: 'CC BY',
			caution: false
		});
	});

	it('reads MakerWorld names', () => {
		expect(classifyLicence('BY-NC-ND')).toMatchObject({
			code: 'CC BY-NC-ND',
			commercial: false,
			remix: false,
			shareAlike: false
		});
		expect(classifyLicence('Standard Digital File License')).toMatchObject({
			commercial: false,
			remix: false,
			caution: true
		});
	});

	it('explains restrictions in plain words and flags unknown licences', () => {
		expect(classifyLicence('BY-NC').meaning.join(' ')).toMatch(/do not sell prints/);
		expect(classifyLicence('BY-ND').meaning.join(' ')).toMatch(/do not share changed versions/);
		expect(classifyLicence(null)).toMatchObject({ code: 'Unknown licence', caution: true });
		expect(classifyLicence('Nokia')).toMatchObject({
			code: 'Nokia',
			commercial: null,
			caution: true
		});
	});
});

describe('credits', () => {
	const p = {
		site: 'printables' as const,
		url: 'https://www.printables.com/model/500000-jar-lid',
		title: 'Jar lid',
		author: 'dmc',
		authorUrl: 'https://www.printables.com/@dmc_289636',
		licence: 'Creative Commons — Attribution — Noncommercial — Share Alike',
		terms: classifyLicence('CC-BY-NC-SA')
	};

	it('names the design, designer, site, link and licence, with what NC means', () => {
		const text = creditText(p);
		expect(text).toContain('“Jar lid” by dmc (https://www.printables.com/@dmc_289636)');
		expect(text).toContain('from Printables: https://www.printables.com/model/500000-jar-lid');
		expect(text).toContain('(CC BY-NC-SA) https://creativecommons.org/licenses/by-nc-sa/4.0/');
		expect(text).toMatch(/Personal use only/);
		expect(creditText({ ...p, author: null, authorUrl: null })).toContain('by an unnamed designer');
	});

	it('never shortens the credit to fit the description limit', () => {
		const credit = creditText(p);
		const long = withCredit('x'.repeat(5000), credit);
		expect(long.length).toBeLessThanOrEqual(4000);
		expect(long.endsWith(credit)).toBe(true);
		expect(long).toContain('…');
		expect(withCredit('', credit)).toBe(credit);
		expect(withCredit('Short.', credit)).toBe(`Short.\n\n${credit}`);
	});
});

describe('helpers', () => {
	it('knows which files it can import', () => {
		expect(fileFormat('Part.STL')).toBe('stl');
		expect(fileFormat('a.b.3mf')).toBe('3mf');
		expect(fileFormat('model.obj')).toBe('obj');
		expect(fileFormat('Bear3_v6.f3d')).toBeNull();
		expect(fileFormat('noext')).toBeNull();
	});

	it('turns HTML into short plain text', () => {
		expect(plainText('<h3>Hi &amp; bye</h3><p>One<br>Two</p><script>x()</script>')).toBe(
			'Hi & bye\nOne\nTwo'
		);
		expect(plainText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
	});
});
