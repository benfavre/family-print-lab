// The queue as the page, the printer panel and the send panel see it: one copy per tab, loaded from
// /api/queue while any of them is on screen and reloaded when the server says the queue changed
// (live channel queue:changed) or a printer's state moves (a print ended, it went offline).
import { onMount } from 'svelte';
import type { LabStore } from '$lib/client/app.svelte';
import type { QueueView } from '$lib/shared/queue';

class QueueStore {
	view = $state<QueueView | null>(null);
	error = $state('');
	private users = 0;
	private off: (() => void) | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private loading: AbortController | null = null;

	/** Starts keeping the queue fresh; returns the function that stops (per user). */
	acquire(lab: LabStore): () => void {
		if (this.users++ === 0) {
			this.off = lab.onLive('queue:changed', () => this.reload());
			void this.load();
		}
		return () => {
			if (--this.users > 0) return;
			this.off?.();
			this.off = null;
			clearTimeout(this.timer);
		};
	}

	/** Loads again shortly (several changes at once make one request). */
	reload() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.load(), 120);
	}

	async load() {
		this.loading?.abort();
		const abort = (this.loading = new AbortController());
		try {
			const r = await fetch('/api/queue', { signal: abort.signal });
			const data = await r.json();
			if (abort.signal.aborted) return;
			if (!r.ok) throw new Error(data.error ?? 'Could not load the queue.');
			this.view = data;
			this.error = '';
		} catch (error) {
			if (!abort.signal.aborted)
				this.error =
					error instanceof TypeError
						? 'Could not reach the app server. Is it still running?'
						: (error as Error).message;
		}
	}

	/** Takes the fresh queue from a write's answer. */
	adopt(data: { queue?: QueueView } | null) {
		if (data?.queue) this.view = data.queue;
	}
}

export const queueStore = new QueueStore();

/** Use in a component: keeps the queue fresh while it is mounted. */
export function useQueue(lab: LabStore) {
	onMount(() => queueStore.acquire(lab));
	// A print ending, a printer going offline or finishing a report changes what can start.
	const key = $derived(
		lab.printerList.map((p) => `${p.id}:${p.connected}:${p.state?.gcodeState}`).join('|')
	);
	let seen = '';
	$effect(() => {
		if (key !== seen && seen) queueStore.reload();
		seen = key;
	});
	return queueStore;
}
