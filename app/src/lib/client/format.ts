// Formatting helpers for the UI. Nothing here produces HTML: highlights are returned as segments.

export const duration = (m: number | null | undefined) =>
	m === null || m === undefined
		? '—'
		: m < 60
			? `${Math.round(m)}m`
			: `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
export const weight = (g: number | null | undefined) =>
	g === null || g === undefined
		? '—'
		: g >= 1000
			? `${(g / 1000).toFixed(2)} kg`
			: `${Math.round(g)} g`;
export const money = (v: number | null | undefined) =>
	v === null || v === undefined ? '—' : v.toFixed(2);
export const stamp = (iso: string | null | undefined) =>
	iso
		? new Date(iso).toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			})
		: '';
export const toLocalInput = (iso: string | null | undefined) => {
	if (!iso) return '';
	const d = new Date(iso);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
export const initials = (name: string) =>
	name
		.trim()
		.split(/\s+/)
		.slice(0, 2)
		.map((x) => x[0])
		.join('')
		.toUpperCase();

export interface Segment {
	text: string;
	mark: boolean;
}

/** Splits text into plain and matching segments (case-insensitive). */
export function highlight(text: string, query: string): Segment[] {
	if (!query) return [{ text, mark: false }];
	const lower = text.toLowerCase(),
		needle = query.toLowerCase(),
		out: Segment[] = [];
	let at = 0,
		hit: number;
	while ((hit = lower.indexOf(needle, at)) !== -1) {
		if (hit > at) out.push({ text: text.slice(at, hit), mark: false });
		out.push({ text: text.slice(hit, hit + needle.length), mark: true });
		at = hit + needle.length;
	}
	if (at < text.length) out.push({ text: text.slice(at), mark: false });
	return out;
}

/** When a search matches outside the title, a short excerpt explains why the row is listed. */
export function matchExcerpt(
	fields: { title: string; description: string; notes: string; material: string; category: string },
	query: string
): Segment[] | null {
	if (!query || fields.title.toLowerCase().includes(query.toLowerCase())) return null;
	for (const text of [fields.description, fields.notes, fields.material, fields.category]) {
		const at = (text || '').toLowerCase().indexOf(query.toLowerCase());
		if (at < 0) continue;
		const start = Math.max(0, at - 18),
			end = Math.min(text.length, at + query.length + 26);
		const segments = highlight(text.slice(start, end).replace(/\s+/g, ' '), query);
		if (start) segments.unshift({ text: '…', mark: false });
		if (end < text.length) segments.push({ text: '…', mark: false });
		return segments;
	}
	return null;
}

export const hmsCode = (h: { attr: number | null; code: number | null }) =>
	[(h.attr ?? 0) >>> 16, (h.attr ?? 0) & 0xffff, (h.code ?? 0) >>> 16, (h.code ?? 0) & 0xffff]
		.map((n) => n.toString(16).toUpperCase().padStart(4, '0'))
		.join('_');
export const temp = (now: number | null | undefined, target?: number | null) =>
	now === null || now === undefined
		? '—'
		: `${Math.round(now)}°${target ? ` / ${Math.round(target)}°` : ''}`;
