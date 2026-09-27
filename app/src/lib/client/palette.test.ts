import { describe, expect, it } from 'vitest';
import { searchPalette } from './palette';

const items = [
	{ label: 'Download every finished print (CSV)', hint: 'Action', keywords: 'filament cost' },
	{ label: 'Calibrate a filament', hint: 'Action' },
	{ label: 'Filament', hint: 'Go to', keywords: 'shelf spools' },
	{ label: 'Family', hint: 'Go to' }
];

describe('command palette search', () => {
	it('puts label matches before keyword matches, keeping the order within each', () => {
		expect(searchPalette(items, 'filament').map((i) => i.label)).toEqual([
			'Filament',
			'Calibrate a filament',
			'Download every finished print (CSV)'
		]);
		expect(searchPalette(items, ' SHELF ').map((i) => i.label)).toEqual(['Filament']);
		expect(searchPalette(items, 'go to').map((i) => i.label)).toEqual(['Filament', 'Family']);
	});

	it('lists everything up to the limit for an empty query', () => {
		expect(searchPalette(items, '', 2)).toHaveLength(2);
		expect(searchPalette(items, 'nothing like this')).toEqual([]);
	});
});
