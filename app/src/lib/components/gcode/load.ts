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
	for (;;) {
		const res = await fetch(url, { signal: o.signal });
		if (res.status === 202) {
			onWaiting(((await res.json()) as PreviewPending).taskId);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, pollMs);
				o.signal.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new DOMException('Stopped', 'AbortError'));
				});
			});
			continue;
		}
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error ?? 'The toolpaths could not be loaded.');
		}
		return decodePreview(await res.arrayBuffer());
	}
}
