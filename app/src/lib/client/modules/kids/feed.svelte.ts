// Data from the kids API for one component: fetched on mount, again whenever the workspace changes
// (requests, jobs) or the server says kids data changed (live channel kids:changed).
import type { LabStore } from '$lib/client/app.svelte';

export function kidsFeed<T>(lab: LabStore, url: () => string | null) {
	const state = $state<{ data: T | null; error: string }>({ data: null, error: '' });
	let seq = 0;
	async function load() {
		const u = url();
		if (!u) return;
		const n = ++seq;
		try {
			const r = await fetch(u);
			const body = await r.json().catch(() => ({}));
			if (n !== seq) return;
			if (r.ok) {
				state.data = body as T;
				state.error = '';
			} else state.error = body.error ?? `Request failed (${r.status}).`;
		} catch {
			if (n === seq) state.error = 'Could not reach the app server. Is it still running?';
		}
	}
	$effect(() => {
		void lab.ws.changeId;
		url();
		void load();
	});
	$effect(() => lab.onLive('kids:changed', () => void load()));
	return {
		get data() {
			return state.data;
		},
		get error() {
			return state.error;
		},
		reload: load
	};
}
