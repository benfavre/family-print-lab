import fs from 'node:fs';
import { error } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';

/** Downloads the attached sliced file, e.g. to open it in Bambu Studio. */
export function GET({ params }) {
	const rt = runtime();
	const job = rt.lab.snapshot().jobs.find((j) => j.id === params.id);
	if (!job?.sliced) error(404, 'No sliced file.');
	const file = rt.printing.file(job.sliced.file);
	if (!fs.existsSync(file)) error(404, 'The sliced file is missing.');
	const name = job.sliced.name.endsWith('.3mf') ? job.sliced.name : `${job.sliced.name}.gcode.3mf`;
	return new Response(new Uint8Array(fs.readFileSync(file)), {
		headers: {
			'content-type': 'model/3mf',
			'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`
		}
	});
}
