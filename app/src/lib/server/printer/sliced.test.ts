import { describe, expect, it } from 'vitest';
import { readZip, writeZip } from '../cad/mesh';
import { fakeSliced, readSliced } from './sliced';

function importedFile(changeInfo: (text: string) => string, changeGcode = (text: string) => text) {
	const files = readZip(fakeSliced({ minutes: 83, grams: 18.5 }), () => 'all');
	for (const [name, change] of [
		['Metadata/slice_info.config', changeInfo],
		['Metadata/plate_1.gcode', changeGcode]
	] as const) {
		files.set(name, Buffer.from(change(files.get(name)!.toString())));
	}
	return readSliced(writeZip([...files])).plates[0];
}

describe('imported sliced estimates', () => {
	it.each(['-2147483648', 'NaN', 'Infinity', '1e309', '1e100', 'broken'])(
		'falls back from invalid plate estimates (%s) to G-code time and filament weights',
		(value) => {
			const plate = importedFile((info) =>
				info.replace(/(key="(?:prediction|weight)" value=")[^"]+/g, `$1${value}`)
			);
			expect(plate.minutes).toBe(83);
			expect(plate.grams).toBe(18.5);
		}
	);

	it('uses the G-code weight when neither XML weight source is usable', () => {
		const plate = importedFile((info) =>
			info
				.replace('key="weight" value="18.5"', 'key="weight" value="-1"')
				.replace('used_g="18.5"', 'used_g="Infinity"')
				.replace(/used_m="[^"]+"/, 'used_m="-12"')
		);
		expect(plate.grams).toBe(18.5);
		expect(plate.filaments[0]).toMatchObject({ grams: 0, meters: 0 });
	});

	it.each(['-10m', 'Infinity', '1e309s', `${'9'.repeat(310)}d`])(
		'keeps unusable estimates finite and non-negative (%s)',
		(duration) => {
			const plate = importedFile(
				(info) =>
					info
						.replace(/(key="(?:prediction|weight)" value=")[^"]+/g, '$1NaN')
						.replace(/(used_[gm]=")[^"]+/g, '$1NaN'),
				(gcode) =>
					gcode
						.replace('total estimated time: 1h 23m 0s', `total estimated time: ${duration}`)
						.replace('total filament weight [g] : 18.5', 'total filament weight [g] : -18.5')
			);
			expect(plate.minutes).toBe(1);
			expect(plate.grams).toBe(0);
		}
	);

	it('preserves valid decimal XML estimates and their precedence over G-code', () => {
		const plate = importedFile((info) =>
			info.replace('value="4980"', 'value="150.5"').replace('value="18.5"', 'value="12.34"')
		);
		expect(plate.minutes).toBe(3);
		expect(plate.grams).toBe(12.3);
	});
});
