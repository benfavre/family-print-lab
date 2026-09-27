import { describe, expect, it } from 'vitest';
import {
	colourName,
	dryingDefaults,
	dryingRange,
	humidityLevel,
	matchTray,
	presetFor,
	remainDisagreement,
	spoolFromTray,
	stillHolds,
	trayColour,
	trayPlace,
	type AmsSpool
} from './ams';
import type { AmsUnit, PrinterTray } from './printers/status';

const tray = (over: Partial<PrinterTray> = {}): PrinterTray => ({
	slot: '0',
	active: false,
	type: 'PLA',
	name: '',
	color: '#ffffff',
	remain: 80,
	global: 0,
	colors: [],
	infoIdx: '',
	idName: '',
	tagUid: null,
	trayUuid: null,
	weight: null,
	diameter: 1.75,
	tempMin: 190,
	tempMax: 230,
	bedTemp: null,
	dryingTemp: null,
	dryingHours: null,
	k: null,
	state: 11,
	totalLengthMm: null,
	isBambu: false,
	...over
});
let n = 0;
const spool = (over: Partial<AmsSpool> = {}): AmsSpool => ({
	id: `s${++n}`,
	brand: '',
	material: 'PLA',
	colorName: '',
	colorHex: '#ffffff',
	totalGrams: 1000,
	remainingGrams: 800,
	cost: null,
	notes: '',
	version: 1,
	createdAt: '',
	updatedAt: '',
	rfidUuid: null,
	rfidTag: null,
	bambuInfoIdx: null,
	spoolmanId: null,
	...over
});

describe('matching a tray to a shelf spool', () => {
	it('keeps the linked spool', () => {
		const s = spool();
		expect(matchTray(tray(), [s], { linkedSpoolId: s.id })).toEqual({
			kind: 'linked',
			spoolId: s.id
		});
	});

	it('finds an RFID spool by tray_uuid, then by tag_uid', () => {
		const a = spool({ rfidUuid: 'U1', rfidTag: 'T1', colorHex: '#000000' });
		const b = spool({ rfidTag: 'T2' });
		expect(matchTray(tray({ trayUuid: 'U1', tagUid: 'T9' }), [b, a])).toEqual({
			kind: 'rfid',
			spoolId: a.id
		});
		expect(matchTray(tray({ tagUid: 'T2' }), [a, b])).toEqual({ kind: 'rfid', spoolId: b.id });
	});

	it('offers "Add to Filament" for an unknown RFID spool, or a close plain spool to confirm', () => {
		const tagged = tray({ trayUuid: 'NEW', tagUid: 'TAG', color: '#101010' });
		expect(matchTray(tagged, [spool({ rfidUuid: 'OTHER', colorHex: '#101010' })])).toEqual({
			kind: 'new-rfid'
		});
		const plain = spool({ colorHex: '#121212', brand: 'Bambu Lab' });
		expect(matchTray(tagged, [plain])).toEqual({
			kind: 'suggest',
			spoolIds: [plain.id],
			ambiguous: false
		});
	});

	it('falls back to material and colour, best first, and says when it is ambiguous', () => {
		const near = spool({ colorHex: '#fefefe' });
		const nearToo = spool({ colorHex: '#f8f8f8' });
		const far = spool({ colorHex: '#ff0000' });
		const petg = spool({ material: 'PETG', colorHex: '#ffffff' });
		const m = matchTray(tray(), [far, petg, nearToo, near]);
		expect(m).toEqual({ kind: 'suggest', spoolIds: [near.id, nearToo.id], ambiguous: true });
		expect(matchTray(tray(), [near, far])).toMatchObject({ ambiguous: false });
		// PLA Matte is PLA; a spool in another tray is not offered.
		const matte = spool({ material: 'PLA Matte' });
		expect(matchTray(tray(), [matte], { taken: new Set([matte.id]) })).toEqual({ kind: 'none' });
		expect(matchTray(tray(), [matte])).toMatchObject({ spoolIds: [matte.id] });
		expect(matchTray(tray({ type: '' }), [near])).toEqual({ kind: 'none' });
	});

	it('knows when a tray no longer holds its linked spool', () => {
		const plain = spool();
		expect(stillHolds(tray(), plain)).toBe(true);
		expect(stillHolds(tray({ type: '' }), plain)).toBe(false);
		expect(stillHolds(tray({ color: '#ff0000' }), plain)).toBe(false);
		expect(stillHolds(tray({ trayUuid: 'U' }), plain)).toBe(false);
		const rfid = spool({ rfidUuid: 'U', rfidTag: 'T' });
		expect(stillHolds(tray({ trayUuid: 'U' }), rfid)).toBe(true);
		expect(stillHolds(tray({ trayUuid: 'V' }), rfid)).toBe(false);
		expect(stillHolds(tray(), rfid)).toBe(false);
		expect(stillHolds(undefined, rfid)).toBe(false);
	});
});

describe('RFID remaining estimate', () => {
	it('only speaks up past 10 % of the spool, and only for RFID spools', () => {
		const s = spool({ rfidUuid: 'U', totalGrams: 1000, remainingGrams: 800 });
		expect(remainDisagreement(tray({ remain: 75 }), s)).toBeNull();
		expect(remainDisagreement(tray({ remain: 60 }), s)).toEqual({ printerGrams: 600 });
		expect(remainDisagreement(tray({ remain: 60 }), spool({ remainingGrams: 800 }))).toBeNull();
		expect(remainDisagreement(tray({ remain: null }), s)).toBeNull();
	});
});

describe('humidity and drying', () => {
	const unit = (o: Partial<AmsUnit>) =>
		({ humidityIndex: null, humidityPercent: null, ...o }) as AmsUnit;
	it('reads humidity 1 dry … 5 wet: % on the AMS 2 Pro and AMS HT, the index elsewhere', () => {
		expect(humidityLevel(unit({ humidityIndex: 5 }))).toBe(1);
		expect(humidityLevel(unit({ humidityIndex: 1 }))).toBe(5);
		expect(humidityLevel(unit({ humidityIndex: 5, humidityPercent: 12 }))).toBe(1);
		expect(humidityLevel(unit({ humidityPercent: 45 }))).toBe(3);
		expect(humidityLevel(unit({ humidityPercent: 85 }))).toBe(5);
		expect(humidityLevel(unit({}))).toBeNull();
		// Bambu Studio places a plain AMS by its index even when it also sends a percentage.
		expect(humidityLevel(unit({ model: 'AMS', humidityIndex: 4, humidityPercent: 9 }))).toBe(2);
		expect(humidityLevel(unit({ model: 'AMS 2 Pro', humidityIndex: 1, humidityPercent: 29 }))).toBe(
			2
		);
	});
	it('knows which units dry and suggests settings from the spool', () => {
		expect(dryingRange('AMS 2 Pro')).toEqual({ min: 45, max: 65 });
		expect(dryingRange('AMS HT')).toEqual({ min: 45, max: 85 });
		expect(dryingRange('AMS')).toBeNull();
		expect(
			dryingDefaults({ model: 'AMS 2 Pro', trays: [tray({ dryingTemp: 80, dryingHours: 30 })] })
		).toEqual({ temp: 65, hours: 24, filament: 'PLA' });
		// The gentlest loaded filament decides (PLA at 55 °C beside PETG at 65 °C).
		expect(
			dryingDefaults({
				model: 'AMS 2 Pro',
				trays: [
					tray({ type: 'PETG', dryingTemp: 65, dryingHours: 8 }),
					tray({ type: '', dryingTemp: 45 }),
					tray({ type: 'PLA', dryingTemp: 55, dryingHours: 8 })
				]
			})
		).toEqual({ temp: 55, hours: 8, filament: 'PLA' });
		expect(dryingDefaults({ model: 'AMS HT', trays: [] })).toEqual({
			temp: 55,
			hours: 8,
			filament: ''
		});
	});
});

describe('tray settings helpers', () => {
	it('maps materials to Bambu generic profiles and colours to RRGGBBAA', () => {
		expect(presetFor('PLA Silk')).toMatchObject({ type: 'PLA', infoIdx: 'GFL96' });
		expect(presetFor('petg')).toMatchObject({ type: 'PETG', infoIdx: 'GFG99' });
		expect(presetFor('PLA-S')).toMatchObject({ type: 'PLA' });
		expect(presetFor('Wood')).toBeNull();
		expect(trayColour('#12abEF')).toBe('12ABEFFF');
	});
	it('names colours and places', () => {
		expect(colourName('#fdfdfd')).toBe('White');
		expect(colourName('#0a2989')).toBe('Blue');
		expect(trayPlace(5, { printerName: 'P1S', several: true })).toBe('P1S, tray B2');
		expect(trayPlace(255, { dual: true })).toBe('external spool R');
	});
	it('makes a shelf spool from an RFID tray', () => {
		const made = spoolFromTray(
			tray({
				trayUuid: 'U',
				tagUid: 'T',
				infoIdx: 'GFA00',
				name: 'PLA Basic',
				weight: 1000,
				remain: 42,
				color: '#0a2989'
			})
		);
		expect(made).toEqual({
			input: {
				brand: 'Bambu Lab',
				material: 'PLA',
				colorName: 'Blue',
				colorHex: '#0a2989',
				totalGrams: 1000,
				remainingGrams: 420,
				notes: 'PLA Basic'
			},
			rfid: { rfidUuid: 'U', rfidTag: 'T', bambuInfoIdx: 'GFA00' }
		});
	});
});
