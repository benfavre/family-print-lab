import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';

/**
 * The toolpath preview of a plate (?plate=N, default the chosen plate) as the binary preview container.
 * Large plates are read in the background first: then the answer is 202 with the task to wait for, and
 * the client asks again. Links carry the stored file name (&f=…), so a new file gets a new address and
 * the long cache never shows an old preview.
 */
export const GET = api(async ({ params, url }, rt) => {
	const previews = rt.module('gcode-preview');
	if (!previews) throw new AppError(503, 'Toolpath previews are switched off.');
	const job = rt.lab.getJob(params.id!);
	if (!job?.sliced) throw new AppError(404, 'This job has no sliced file.');
	const plate = Number(url.searchParams.get('plate') ?? job.sliced.plate);
	if (!Number.isInteger(plate) || plate < 1) throw new AppError(400, 'Choose a plate.');
	const answer = await previews.get(job, plate);
	if ('taskId' in answer)
		return json({ status: 'parsing', taskId: answer.taskId }, { status: 202 });
	const current = url.searchParams.get('f') === job.sliced.file;
	// No copy: previews of big plates run to 100 MB and more.
	const body = answer.bytes as Uint8Array as Uint8Array<ArrayBuffer>;
	return new Response(body, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-length': String(answer.bytes.length),
			'cache-control': current ? 'private, max-age=31536000, immutable' : 'no-cache'
		}
	});
});
