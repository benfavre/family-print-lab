// Kid mode: the "make something" templates a child can customize, described for the UI. The OpenSCAD
// sources and the safety checks live on the server (src/lib/server/kid/templates.ts).
import type { KidLevel } from './domain';

export interface KidChoice {
	value: string;
	label: string;
	/** A short emoji shown on the big button. */
	icon: string;
}

export type KidControl =
	| {
			kind: 'text';
			name: string;
			label: string;
			placeholder: string;
			/** Longest text allowed, per level. */
			max: Record<KidLevel, number>;
	  }
	| {
			kind: 'size';
			name: string;
			label: string;
			/** Words at each end of the slider ("small", "big"). */
			ends: [string, string];
			step: number;
			/** Allowed range in millimetres, per level (little makers get bigger, sturdier parts). */
			range: Record<KidLevel, [number, number]>;
	  }
	| { kind: 'choice'; name: string; label: string; options: KidChoice[] };

export interface KidTemplate {
	id: string;
	title: string;
	/** One line a child (or the grown-up reading with them) understands. */
	blurb: string;
	icon: string;
	levels: KidLevel[];
	/** 'free' templates ship with the app; packs can add more later. */
	pack: 'free';
	controls: KidControl[];
	/** Starting values; numbers are clamped to the level's range. */
	defaults: Record<string, string | number>;
}

const SHAPES: KidChoice[] = [
	{ value: 'star', label: 'Star', icon: '⭐' },
	{ value: 'heart', label: 'Heart', icon: '❤️' },
	{ value: 'circle', label: 'Circle', icon: '⚪' },
	{ value: 'flower', label: 'Flower', icon: '🌸' },
	{ value: 'moon', label: 'Moon', icon: '🌙' }
];

export const KID_TEMPLATES: KidTemplate[] = [
	{
		id: 'name-sign',
		title: 'Name sign',
		blurb: 'Your name in big raised letters, for your door or desk.',
		icon: '🔤',
		levels: ['little', 'junior'],
		pack: 'free',
		controls: [
			{
				kind: 'text',
				name: 'name',
				label: 'What should it say?',
				placeholder: 'Your name',
				max: { little: 8, junior: 14 }
			},
			{
				kind: 'size',
				name: 'wanted_letter',
				label: 'How big are the letters?',
				ends: ['small', 'big'],
				step: 1,
				range: { little: [16, 26], junior: [10, 26] }
			},
			{
				kind: 'choice',
				name: 'shape',
				label: 'Sign shape',
				options: [
					{ value: 'rounded', label: 'Rounded', icon: '▢' },
					{ value: 'bubble', label: 'Bubble', icon: '🫧' }
				]
			},
			{
				kind: 'choice',
				name: 'extra',
				label: 'Anything extra?',
				options: [
					{ value: 'none', label: 'Just letters', icon: '✨' },
					{ value: 'border', label: 'A border', icon: '🖼️' },
					{ value: 'hole', label: 'A hole to hang it', icon: '🪝' }
				]
			}
		],
		defaults: { name: '', wanted_letter: 18, shape: 'rounded', extra: 'none' }
	},
	{
		id: 'pencil-cup',
		title: 'Pencil cup',
		blurb: 'A cup for pencils and pens. Make it twisty!',
		icon: '✏️',
		levels: ['little', 'junior'],
		pack: 'free',
		controls: [
			{
				kind: 'size',
				name: 'height',
				label: 'How tall?',
				ends: ['short', 'tall'],
				step: 5,
				range: { little: [70, 100], junior: [60, 110] }
			},
			{
				kind: 'size',
				name: 'width',
				label: 'How wide?',
				ends: ['thin', 'wide'],
				step: 5,
				range: { little: [60, 90], junior: [50, 90] }
			},
			{
				kind: 'choice',
				name: 'sides',
				label: 'Shape',
				options: [
					{ value: 'round', label: 'Round', icon: '⚪' },
					{ value: 'hexagon', label: 'Hexagon', icon: '⬡' },
					{ value: 'star', label: 'Star', icon: '⭐' }
				]
			},
			{
				kind: 'choice',
				name: 'twist',
				label: 'Twist it?',
				options: [
					{ value: 'no', label: 'Straight', icon: '📏' },
					{ value: 'yes', label: 'Twisty', icon: '🌀' }
				]
			}
		],
		defaults: { height: 80, width: 70, sides: 'hexagon', twist: 'yes' }
	},
	{
		id: 'treasure-dish',
		title: 'Treasure dish',
		blurb: 'A little dish in a fun shape for your treasures.',
		icon: '💎',
		levels: ['little', 'junior'],
		pack: 'free',
		controls: [
			{ kind: 'choice', name: 'shape', label: 'Pick a shape', options: SHAPES },
			{
				kind: 'size',
				name: 'size',
				label: 'How big?',
				ends: ['small', 'big'],
				step: 5,
				range: { little: [80, 130], junior: [60, 130] }
			},
			{
				kind: 'size',
				name: 'depth',
				label: 'How deep?',
				ends: ['flat', 'deep'],
				step: 1,
				range: { little: [12, 25], junior: [8, 30] }
			}
		],
		defaults: { shape: 'star', size: 90, depth: 15 }
	},
	{
		id: 'stencil',
		title: 'Drawing stencil',
		blurb: 'Trace the shape again and again with your pencils.',
		icon: '🎨',
		levels: ['little', 'junior'],
		pack: 'free',
		controls: [
			{ kind: 'choice', name: 'shape', label: 'Pick a shape', options: SHAPES },
			{
				kind: 'size',
				name: 'size',
				label: 'How big is the shape?',
				ends: ['small', 'big'],
				step: 5,
				range: { little: [60, 100], junior: [40, 100] }
			}
		],
		defaults: { shape: 'heart', size: 70 }
	},
	{
		id: 'keychain',
		title: 'Keychain tag',
		blurb: 'A tag with your name for your bag or keys.',
		icon: '🔑',
		// Small by nature, so only for older kids.
		levels: ['junior'],
		pack: 'free',
		controls: [
			{
				kind: 'text',
				name: 'name',
				label: 'What should it say?',
				placeholder: 'Your name',
				max: { little: 0, junior: 10 }
			},
			{
				kind: 'choice',
				name: 'shape',
				label: 'Tag shape',
				options: SHAPES.filter((s) => s.value !== 'moon')
			},
			{
				kind: 'size',
				name: 'size',
				label: 'How big?',
				ends: ['small', 'big'],
				step: 5,
				range: { little: [45, 60], junior: [40, 60] }
			}
		],
		defaults: { name: '', shape: 'circle', size: 50 }
	}
];

export const kidTemplate = (id: string) => KID_TEMPLATES.find((t) => t.id === id);

export const templatesFor = (level: KidLevel) =>
	KID_TEMPLATES.filter((t) => t.levels.includes(level));

/** Grams of PLA for a mesh volume in mm³ (1.24 g/cm³), for time and filament hints. */
export const plaGrams = (volumeMm3: number) => Math.round((volumeMm3 / 1000) * 1.24);

/**
 * Whether a part could fit the small-parts test cylinder (31.7 mm wide, 57.1 mm deep) used for toys
 * for children under 3. Conservative: it only compares the bounding box, never the true shape.
 */
export function smallPartsHazard(size: readonly number[]) {
	const [a, b, c] = [...size].sort((x, y) => x - y);
	return a <= 31.7 && b <= 31.7 && c <= 57.1;
}
