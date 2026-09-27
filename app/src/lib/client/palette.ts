// The command palette's search: an item matches when its label, hint or keywords contain the query,
// and label matches come first (a label that starts with the query, then one that contains it), so
// "filament" opens the Filament shelf, not an action that only mentions filament in its keywords.

export interface PaletteItem {
	label: string;
	/** Shown after the label ("Go to", "Action"). */
	hint: string;
	/** Searched, never shown. */
	keywords?: string;
}

export function searchPalette<T extends PaletteItem>(items: T[], query: string, limit = 12): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return items.slice(0, limit);
	const rank = (i: T) => {
		const label = i.label.toLowerCase();
		if (label.startsWith(q)) return 0;
		if (label.includes(q)) return 1;
		return `${i.hint} ${i.keywords ?? ''}`.toLowerCase().includes(q) ? 2 : -1;
	};
	return items
		.map((item, index) => ({ item, index, rank: rank(item) }))
		.filter((r) => r.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.slice(0, limit)
		.map((r) => r.item);
}
