// Fetches a plate's toolpath preview. Large plates are read in the background first: the server answers
// 202 with the task, and this asks again until the preview is ready.
import { decodePreview, type PreviewData } from '$lib/shared/slicer/preview';
import type { PreviewPending } from '$lib/shared/gcode-preview';

export async function loadPreview(
	o: { jobId: string; plate: number; file: string; signal: AbortSignal },
	onWaiting: (taskId: string) => void,
	pollMs = 1500
): Promise<PreviewData> {
	const url = `/api/jobs/${o.jobId}/sliced/preview?plate=${o.plate}&f=${encodeURIComponent(o.file)}`;
	let task: string | null = null;
	for (;;) {
		const res = await fetch(url, { signal: o.signal });
		if (res.status === 202) {
			const { taskId } = (await res.json()) as PreviewPending;
			// A new task means the last one was stopped (a failure answers 422): asking again would only
			// start it over, so leave that to the person.
			if (task && taskId !== task) throw new Error('Reading the toolpaths was stopped.');
			task = taskId;
			onWaiting(taskId);
			await wait(pollMs, o.signal);
			continue;
		}
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error ?? 'The toolpaths could not be loaded.');
		}
		return decodePreview(await res.arrayBuffer());
	}
}

function wait(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			reject(new DOMException('Stopped', 'AbortError'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop);
			resolve();
		}, ms);
		if (signal.aborted) stop();
		else signal.addEventListener('abort', stop, { once: true });
	});
}
