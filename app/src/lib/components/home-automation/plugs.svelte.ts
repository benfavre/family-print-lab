// Smart plugs and their power state in the browser, shared by the Home automation settings and the
// printer page's Power panel: loaded from /api/plugs, kept current by the home-automation:power live
// channel.
import type { AppContext } from '$lib/client/app.svelte';
import type { PlugInfo, PowerState } from '$lib/shared/home-automation';

class Plugs {
	list = $state<PlugInfo[]>([]);
	states = $state<Record<string, PowerState>>({});
	loaded = $state(false);
	private watching = 0;
	private off: (() => void) | null = null;

	forPrinter(printerId: string | undefined): PlugInfo | null {
		return this.list.find((p) => p.printerId === printerId) ?? null;
	}

	state(printerId: string | undefined): PowerState | null {
		return printerId ? (this.states[printerId] ?? null) : null;
	}

	async load(lab: AppContext['lab']) {
		const res = await lab.call<{ plugs: PlugInfo[]; states: PowerState[] }>('GET', '/api/plugs');
		if (!res) return;
		this.list = res.plugs;
		this.states = Object.fromEntries(res.states.map((s) => [s.printerId, s]));
		this.loaded = true;
	}

	/** Listens for power changes while at least one component needs them; returns the stop function. */
	watch(lab: AppContext['lab']): () => void {
		if (this.watching++ === 0)
			this.off = lab.onLive<PowerState>('home-automation:power', (s) => {
				this.states = { ...this.states, [s.printerId]: s };
			});
		void this.load(lab);
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
