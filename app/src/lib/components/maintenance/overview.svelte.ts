// One printer's maintenance, loaded from /api/printers/[id]/maintenance and reloaded when the server says
// it changed (live channel maintenance:changed: a print ended, a task was done, a reminder went out).
import type { LabStore } from '$lib/client/app.svelte';
import type { MaintenanceOverview } from '$lib/shared/maintenance';

export class MaintenanceData {
	overview = $state<MaintenanceOverview | null>(null);
	error = $state('');
	/** Tasks with a Done on its way (so a second tap does not log it twice). */
	pending = $state<string[]>([]);
	private loading: Promise<void> | null = null;
	/** A change arrived during a load: load once more after it. */
	private stale = false;

	constructor(
		private lab: LabStore,
		private printerId: () => string
	) {}

	get base() {
		return `/api/printers/${encodeURIComponent(this.printerId())}/maintenance`;
	}

	load(): Promise<void> {
		if (this.loading) {
			this.stale = true;
			return this.loading;
		}
		return (this.loading = (async () => {
			const id = this.printerId();
			try {
				const res = await fetch(this.base);
				const data = await res.json().catch(() => ({}));
				if (id !== this.printerId()) return;
				if (!res.ok) {
					this.error = data.error ?? `Could not load maintenance (${res.status}).`;
					return;
				}
				this.error = '';
				this.overview = data;
			} catch {
				this.error = 'Could not reach the app server. Is it still running?';
			} finally {
				this.loading = null;
				if (this.stale) {
					this.stale = false;
					void this.load();
				}
			}
		})());
	}

	/** Loads now and whenever this printer's maintenance changes; returns the unsubscribe. */
	watch(): () => void {
		void this.load();
		return this.lab.onLive<{ printerId: string }>('maintenance:changed', (d) => {
			if (d.printerId === this.printerId()) void this.load();
		});
	}

	/** Runs a write; applies the overview it returns. Returns the body or null (the app toasts errors). */
	async write(method: string, path: string, body: unknown, success?: string) {
		const res = await this.lab.call<{ overview?: MaintenanceOverview }>(
			method,
			`${this.base}${path}`,
			body,
			success
		);
		if (res?.overview) this.overview = res.overview;
		return res;
	}

	async done(taskId: string, note = '') {
		if (this.pending.includes(taskId)) return null;
		this.pending = [...this.pending, taskId];
		try {
			return await this.write('POST', `/tasks/${taskId}/done`, { note }, 'Marked as done.');
		} finally {
			this.pending = this.pending.filter((id) => id !== taskId);
		}
	}
}
