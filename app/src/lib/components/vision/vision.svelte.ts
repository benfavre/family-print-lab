// One printer's AI checks, loaded from /api/printers/[id]/vision and reloaded when the server says a
// check started or finished (live channel ai-vision:check).
import type { LabStore } from '$lib/client/app.svelte';
import type { VisionCheck, VisionOverview, VisionVerdict } from '$lib/shared/vision';

export class VisionData {
	overview = $state<VisionOverview | null>(null);
	error = $state('');
	/** A check is running (from the server, or the button just pressed). */
	running = $state(false);
	/** Bumped when a check finishes, so a history list reloads. */
	version = $state(0);

	constructor(
		private lab: LabStore,
		private printerId: () => string
	) {}

	get base() {
		return `/api/printers/${encodeURIComponent(this.printerId())}/vision`;
	}

	frameUrl(check: Pick<VisionCheck, 'id'>) {
		return `${this.base}/frames/${encodeURIComponent(check.id)}`;
	}

	async load() {
		const id = this.printerId();
		try {
			const res = await fetch(this.base);
			const data = await res.json().catch(() => ({}));
			if (id !== this.printerId()) return;
			if (!res.ok) {
				this.error = data.error ?? `Could not load the AI checks (${res.status}).`;
				return;
			}
			this.error = '';
			this.overview = data;
			this.running = data.running;
		} catch {
			this.error = 'Could not reach the app server. Is it still running?';
		}
	}

	/** Loads now and whenever this printer's checks change; returns the unsubscribe. */
	watch(): () => void {
		void this.load();
		return this.lab.onLive<{ printerId: string; running: boolean; check?: VisionCheck }>(
			'ai-vision:check',
			(d) => {
				if (d.printerId !== this.printerId()) return;
				this.running = d.running;
				if (d.check) {
					this.version++;
					void this.load();
				}
			}
		);
	}

	async checkNow() {
		if (this.running) return;
		this.running = true;
		try {
			const res = await this.lab.call<{ check: VisionCheck; overview: VisionOverview }>(
				'POST',
				`${this.base}/check`
			);
			if (res?.overview) this.overview = res.overview;
			if (res?.check) this.version++;
		} finally {
			this.running = false;
		}
	}

	async setPrinter(enabled: boolean) {
		const res = await this.lab.call<{ overview: VisionOverview }>(
			'PUT',
			`${this.base}/printer`,
			{ enabled },
			enabled ? 'AI checks on for this printer.' : 'AI checks off for this printer.'
		);
		if (res?.overview) this.overview = res.overview;
	}
}

/** The colour a verdict is shown in. */
export function verdictTone(v: VisionVerdict, error: string | null): string {
	if (error) return 'var(--dim)';
	if (v === 'ok') return 'var(--lime)';
	if (v === 'unsure') return 'var(--amber)';
	return 'var(--red)';
}

/** "every 20 layers or 10 minutes". */
export function scheduleText(s: { everyLayers: number | null; everyMinutes: number | null }) {
	const parts = [
		s.everyLayers && `${s.everyLayers} ${s.everyLayers === 1 ? 'layer' : 'layers'}`,
		s.everyMinutes && `${s.everyMinutes} ${s.everyMinutes === 1 ? 'minute' : 'minutes'}`
	].filter(Boolean);
	return parts.length ? `every ${parts.join(' or ')}` : 'only when you press Check now';
}
