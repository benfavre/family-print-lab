// Tray links in the browser: which spool is in which tray, per printer, kept fresh by the module's
// `ams:links` live channel. One shared store for the AMS panel, the spool editor and the Filament page.
import type { AppContext } from '$lib/client/app.svelte';
import type { AmsLink, AmsState } from '$lib/shared/ams';

class AmsLinks {
	states = $state<Record<string, AmsState>>({});
	private watching = new Map<string, number>();
	private off: (() => void) | null = null;

	async load(printerId: string) {
		try {
			const r = await fetch(`/api/printers/${encodeURIComponent(printerId)}/ams`);
			if (r.ok) this.states = { ...this.states, [printerId]: await r.json() };
		} catch {
			/* offline or AMS sync not running: keep what we had */
		}
	}

	/** Adopts the state a write route returned. */
	adopt(state: AmsState | null | undefined) {
		if (state?.printerId) this.states = { ...this.states, [state.printerId]: state };
	}

	/** Keeps these printers' links loaded while the caller is mounted; returns the cleanup. */
	watch(app: AppContext, printerIds: string[]): () => void {
		this.off ??= app.lab.onLive<{ printerId: string }>('ams:links', (d) => {
			if (d?.printerId && this.watching.has(d.printerId)) void this.load(d.printerId);
		});
		for (const id of printerIds) {
			this.watching.set(id, (this.watching.get(id) ?? 0) + 1);
			void this.load(id);
		}
		return () => {
			for (const id of printerIds) {
				const n = (this.watching.get(id) ?? 1) - 1;
				if (n > 0) this.watching.set(id, n);
				else this.watching.delete(id);
			}
		};
	}

	link(printerId: string, tray: number): AmsLink | undefined {
		return this.states[printerId]?.links.find((l) => l.tray === tray);
	}

	/** Where a spool is loaded, if anywhere. */
	whereIs(spoolId: string): AmsLink | undefined {
		for (const s of Object.values(this.states)) {
			const l = s.links.find((x) => x.spoolId === spoolId);
			if (l) return l;
		}
		return undefined;
	}
}

export const amsLinks = new AmsLinks();
