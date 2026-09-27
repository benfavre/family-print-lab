// Calibration as the page sees it: the tests the slicer can make and the runs so far, loaded from
// /api/calibration and reloaded when the server says a run changed (live channel
// slicer-calibration:runs: slicing finished or failed, a result was saved).
import type { LabStore } from '$lib/client/app.svelte';
import type { CalibOverview, CalibRun } from '$lib/shared/slicer-calibration';

export class CalibrationData {
	overview = $state<CalibOverview | null>(null);
	error = $state('');
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private lab: LabStore) {}

	async load() {
		try {
			const res = await fetch('/api/calibration');
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				this.error = data.error ?? `Could not load calibration (${res.status}).`;
				return;
			}
			this.error = '';
			this.overview = data;
		} catch {
			this.error = 'Could not reach the app server. Is it still running?';
		}
	}

	/** Loads now and whenever a run changes; returns the unsubscribe. */
	watch(): () => void {
		void this.load();
		const off = this.lab.onLive('slicer-calibration:runs', () => {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => void this.load(), 100);
		});
		return () => {
			off();
			clearTimeout(this.timer);
		};
	}

	/** A write through the lab (toasts on error); the fresh run replaces the old one in place. */
	async write(method: string, path: string, body?: unknown, success?: string) {
		const run = await this.lab.call<CalibRun>(method, `/api/calibration${path}`, body, success);
		if (run?.id && this.overview) {
			const runs = this.overview.runs;
			this.overview = {
				...this.overview,
				runs: runs.some((r) => r.id === run.id)
					? runs.map((r) => (r.id === run.id ? run : r))
					: [run, ...runs]
			};
		}
		return run;
	}

	async remove(id: string) {
		const ok = await this.lab.call('DELETE', `/api/calibration/runs/${id}`, undefined, 'Removed.');
		if (ok && this.overview)
			this.overview = { ...this.overview, runs: this.overview.runs.filter((r) => r.id !== id) };
	}
}
