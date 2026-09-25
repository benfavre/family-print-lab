import { error } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';

/**
 * The slicer's picture of a plate (?plate=N). Links carry the stored file name (&f=…), so a new file
 * gets a new address and the long cache never shows an old picture.
 */
export function GET({ params, url }) {
	const rt = runtime();
	const job = rt.lab.getJob(params.id);
	if (!job?.sliced) error(404, 'No sliced file.');
	const png = rt.printing.thumbnail(
		job.sliced.file,
		Number(url.searchParams.get('plate') ?? job.sliced.plate)
	);
	if (!png) error(404, 'No picture for that plate.');
	const current = url.searchParams.get('f') === job.sliced.file;
	return new Response(new Uint8Array(png), {
		headers: {
			'content-type': 'image/png',
			'cache-control': current ? 'private, max-age=31536000, immutable' : 'no-cache'
		}
	});
}
