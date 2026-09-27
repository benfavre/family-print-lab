// Spoolman (https://github.com/Donkie/Spoolman), an optional self-hosted spool inventory. Off until
// the person turns it on and gives its address; nothing is sent before that. Endpoints verified
// against Spoolman's API source (spoolman/api/v1/spool.py and models.py at 5b93b3b, the same as its
// OpenAPI page at <url>/api/v1/docs): GET /api/v1/spool lists spools, PUT /api/v1/spool/{id}/use with
// { use_weight } records grams used (negative gives them back), GET /api/v1/info answers a health check.
// Spoolman has no login of its own; the optional token is sent as a Bearer header for a reverse proxy.
import { AppError } from '../../validation';
import { colourName } from '$lib/shared/ams';

export interface SpoolmanFilament {
	id: number;
	name?: string | null;
	material?: string | null;
	color_hex?: string | null;
	multi_color_hexes?: string | null;
	weight?: number | null;
	vendor?: { id: number; name: string } | null;
}
export interface SpoolmanSpool {
	id: number;
	filament: SpoolmanFilament;
	remaining_weight?: number | null;
	initial_weight?: number | null;
	used_weight: number;
	archived?: boolean;
	comment?: string | null;
}

type Fetch = typeof fetch;

/** Checks and normalises a Spoolman address: http(s) only, no credentials, no query or fragment. */
export function spoolmanBase(url: string): string {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		throw new AppError(400, 'That is not a web address.');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:')
		throw new AppError(400, 'Use an http:// or https:// address.');
	if (u.username || u.password) throw new AppError(400, 'Leave the user name out of the address.');
	return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export class SpoolmanClient {
	private base: string;
	constructor(
		url: string,
		private token = '',
		private fetchImpl: Fetch = fetch,
		private timeoutMs = 8000
	) {
		this.base = spoolmanBase(url);
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.base}/api/v1${path}`, {
				method,
				headers: {
					accept: 'application/json',
					...(body !== undefined && { 'content-type': 'application/json' }),
					...(this.token && { authorization: `Bearer ${this.token}` })
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
				redirect: 'error'
			});
		} catch {
			throw new AppError(502, 'Spoolman did not answer. Check the address and that it is running.');
		}
		if (!response.ok) {
			const detail = await response
				.json()
				.then((d: { message?: unknown }) => (typeof d?.message === 'string' ? d.message : ''))
				.catch(() => '');
			throw new AppError(
				502,
				`Spoolman said ${response.status}${detail ? `: ${detail.slice(0, 200)}` : '.'}`
			);
		}
		return (await response.json()) as T;
	}

	info() {
		return this.call<{ version?: string }>('GET', '/info');
	}

	async spools(): Promise<SpoolmanSpool[]> {
		const list = await this.call<unknown>('GET', '/spool');
		if (!Array.isArray(list)) throw new AppError(502, 'Spoolman sent something unexpected.');
		return list.filter(
			(s): s is SpoolmanSpool =>
				!!s && typeof s === 'object' && Number.isInteger((s as SpoolmanSpool).id)
		);
	}

	/** Records grams used on a spool (negative grams give them back). */
	use(id: number, grams: number) {
		return this.call<SpoolmanSpool>('PUT', `/spool/${id}/use`, { use_weight: grams });
	}
}

/** A shelf spool from a Spoolman spool (import). */
export function shelfSpoolFrom(s: SpoolmanSpool) {
	const hex = (s.filament.color_hex || s.filament.multi_color_hexes?.split(',')[0] || 'ffffff')
		.replace('#', '')
		.slice(0, 6);
	const colorHex = /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : '#ffffff';
	const total = Math.min(100_000, Math.max(1, s.initial_weight ?? s.filament.weight ?? 1000));
	const remaining = Math.min(
		total,
		Math.max(0, s.remaining_weight ?? total - (s.used_weight ?? 0))
	);
	return {
		brand: (s.filament.vendor?.name ?? '').slice(0, 80),
		material: (s.filament.material || 'Other').slice(0, 40),
		colorName: (s.filament.name || colourName(colorHex)).slice(0, 80),
		colorHex,
		totalGrams: Math.round(total * 10) / 10,
		remainingGrams: Math.round(remaining * 10) / 10,
		notes: (s.comment ?? '').slice(0, 1000)
	};
}

/** Grams left on a Spoolman spool, or null when it does not say. */
export function spoolmanRemaining(s: SpoolmanSpool): number | null {
	if (typeof s.remaining_weight === 'number') return Math.max(0, s.remaining_weight);
	const total = s.initial_weight ?? s.filament.weight;
	return typeof total === 'number' ? Math.max(0, total - (s.used_weight ?? 0)) : null;
}
