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
	});

	it('still lists objects without a bounding-box file, or with a broken one', () => {
		for (const json of [null, '{not json'])
			expect(readPlateObjects(slicedWithObjects([{ id: 1, name: 'a' }], { json }), 1)).toEqual({
				objects: [{ id: 1, name: 'a', skipped: false, bbox: null }],
				bboxAll: null,
				picture: null
			});
	});

	it('finds nothing on a plate that is not in the file', () => {
		expect(readPlateObjects(slicedWithObjects([{ id: 1, name: 'a' }]), 2).objects).toEqual([]);
	});
});
