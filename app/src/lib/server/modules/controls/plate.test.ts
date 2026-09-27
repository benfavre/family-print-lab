import { describe, expect, it } from 'vitest';
import { readPlateObjects } from './plate';
import { slicedWithObjects } from './fixtures';

describe('plate objects from a sliced file', () => {
	it('lists identify ids, names, skipped flags and first-layer boxes', () => {
		const buf = slicedWithObjects(
			[
				{ id: 139, name: 'rocket &amp; fins', bbox: [20, 30, 60, 80] },
				{ id: 522, name: 'stand', skipped: true }
			],
			{ picture: Buffer.from('png') }
		);
		const c = readPlateObjects(buf, 1);
		expect(c.objects).toEqual([
			{ id: 139, name: 'rocket & fins', skipped: false, bbox: [20, 30, 60, 80] },
			{ id: 522, name: 'stand', skipped: true, bbox: [10, 10, 50, 50] }
		]);
		expect(c.bboxAll).toEqual([10, 10, 200, 150]);
		expect(c.picture?.toString()).toBe('png');
		expect(c.top).toBeNull();
	});

	it('keeps the top view and pick image only as a pair', () => {
		const both = readPlateObjects(
			slicedWithObjects([{ id: 1, name: 'a' }], {
				top: Buffer.from('top'),
				pick: Buffer.from('pick')
			}),
			1
		);
		expect([both.top?.toString(), both.pick?.toString()]).toEqual(['top', 'pick']);
		const one = readPlateObjects(
			slicedWithObjects([{ id: 1, name: 'a' }], { pick: Buffer.from('p') }),
			1
		);
		expect([one.top, one.pick]).toEqual([null, null]);
	});

	it('matches boxes by name, never by id, and leaves out names used twice', () => {
		const buf = slicedWithObjects(
			[
				{ id: 9001, name: 'cube' },
				{ id: 77, name: 'peg', bbox: [1, 1, 5, 5] },
				{ id: 78, name: 'peg', bbox: [6, 6, 9, 9] }
			],
			{
				// bbox_objects ids are PrintObject ids: 9001 here is another object's box.
				json: JSON.stringify({
					bbox_all: [0, 0, 100, 100],
					bbox_objects: [
						{ id: 9001, name: 'peg', bbox: [1, 1, 5, 5] },
						{ id: 5, name: 'cube', bbox: [40, 40, 60, 60] }
					]
				})
			}
		);
		expect(readPlateObjects(buf, 1).objects).toEqual([
			{ id: 9001, name: 'cube', skipped: false, bbox: [40, 40, 60, 60] },
			{ id: 77, name: 'peg', skipped: false, bbox: null },
			{ id: 78, name: 'peg', skipped: false, bbox: null }
		]);
	});

	it('still lists objects without a bounding-box file, or with a broken one', () => {
		for (const json of [null, '{not json'])
			expect(readPlateObjects(slicedWithObjects([{ id: 1, name: 'a' }], { json }), 1)).toEqual({
				objects: [{ id: 1, name: 'a', skipped: false, bbox: null }],
				bboxAll: null,
				picture: null,
				top: null,
				pick: null
			});
	});

	it('finds nothing on a plate that is not in the file', () => {
		expect(readPlateObjects(slicedWithObjects([{ id: 1, name: 'a' }]), 2).objects).toEqual([]);
	});
});
