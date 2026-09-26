// A small valid template pack, as Print Lab Cloud would send it (see kid/packs.ts).
export const TEST_PACK = {
	id: 'test-pack',
	title: 'Test pack',
	blurb: 'A pack for the tests.',
	icon: '🧪',
	templates: [
		{
			id: 'test-block',
			title: 'Block',
			blurb: 'A block with a size.',
			icon: '🧱',
			levels: ['little', 'junior'],
			controls: [
				{
					kind: 'size',
					name: 'size',
					label: 'How big?',
					ends: ['small', 'big'],
					step: 5,
					range: { little: [40, 60], junior: [20, 60] }
				}
			],
			defaults: { size: 40 },
			source: 'size = 40; // [20:5:60]\ncube([size, size, 4]);'
		}
	]
};
