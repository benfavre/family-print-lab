// Smart plugs and their power state in the browser, shared by the Home automation settings and the
// printer page's Power panel: loaded from /api/plugs, kept current by the home-automation:power live
// channel.
import type { AppContext } from '$lib/client/app.svelte';
import type { PlugInfo, PowerState } from '$lib/shared/home-automation';

class Plugs {
	list = $state<PlugInfo[]>([]);
	states = $state<Record<string, PowerState>>({});
	loaded = $state(false);
	/** Why the plugs could not be loaded ('' when they were). */
	error = $state('');
	private watching = 0;
	private off: (() => void) | null = null;

	forPrinter(printerId: string | undefined): PlugInfo | null {
		return this.list.find((p) => p.printerId === printerId) ?? null;
	}

	state(printerId: string | undefined): PowerState | null {
		return printerId ? (this.states[printerId] ?? null) : null;
	}

	/** Loads quietly (every printer page has a Power panel): a failure shows in the panels, not as a toast. */
	async load() {
		try {
			const r = await fetch('/api/plugs');
			const res = await r.json().catch(() => ({}));
			if (!r.ok) {
				this.error = res.error ?? `Could not load the plugs (${r.status}).`;
				return;
			}
			this.list = res.plugs;
			this.states = Object.fromEntries((res.states as PowerState[]).map((s) => [s.printerId, s]));
			this.error = '';
			this.loaded = true;
		} catch {
			this.error = 'Could not reach the app server. Is it still running?';
		}
	}

	/** Listens for power changes while at least one component needs them; returns the stop function. */
	watch(lab: AppContext['lab']): () => void {
		if (this.watching++ === 0)
			this.off = lab.onLive<PowerState>('home-automation:power', (s) => {
				this.states = { ...this.states, [s.printerId]: s };
			});
		void this.load();
		return () => {
			if (--this.watching === 0) {
				this.off?.();
				this.off = null;
			}
		};
	}
}

export const plugs = new Plugs();

/** "On", "Off", or "Unknown" for plugs that cannot say (webhooks). */
export function powerLabel(state: PowerState | null): string {
	return state?.on === true ? 'On' : state?.on === false ? 'Off' : 'Unknown';
}
