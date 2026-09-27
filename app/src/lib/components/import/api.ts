// Calls to /api/imports that show their errors in the window instead of a toast.
import type { LabStore } from '$lib/client/app.svelte';
import type { Workspace } from '$lib/shared/domain';

export async function importCall<T>(
	lab: LabStore,
	method: 'POST' | 'PUT' | 'GET',
	path: string,
	body?: unknown,
	signal?: AbortSignal
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			signal,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error('Could not reach the app server. Is it still running?', { cause: error });
	}
	const data = (await response.json().catch(() => ({}))) as T & {
		error?: string;
		workspace?: Workspace;
	};
	if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
	lab.adopt(data.workspace);
	return data;
}

/** A preview picture through the server (the page only loads its own images). */
export const imageSrc = (url: string) => `/api/imports/image?url=${encodeURIComponent(url)}`;

export function bytes(n: number | null) {
	if (n === null) return '';
	if (n < 1_000_000) return `${Math.max(1, Math.round(n / 1000))} KB`;
	return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}
