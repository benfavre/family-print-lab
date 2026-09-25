import { error } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';

/** The slicer's picture of a plate (?plate=N). Cached: the stored file never changes. */
export function GET({ params, url }) {
	const rt = runtime();
	const job = rt.lab.snapshot().jobs.find((j) => j.id === params.id);
	if (!job?.sliced) error(404, 'No sliced file.');
	const png = rt.printing.thumbnail(
		job.sliced.file,
		Number(url.searchParams.get('plate') ?? job.sliced.plate)
	);
	if (!png) error(404, 'No picture for that plate.');
	return new Response(new Uint8Array(png), {
		headers: {
			'content-type': 'image/png',
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
}
