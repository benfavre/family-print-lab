import fs from 'node:fs';
import { api } from '$lib/server/http';
import { parse } from '$lib/server/validation';
import { workspaceOf } from '$lib/server/modules/slicer-ui/module';
import { plateQuery } from '$lib/server/modules/slicer-ui/validation';

/** The sliced plate as a printer file (.gcode.3mf), to keep or print by hand. */
export const GET = api(({ params, url }, rt) => {
	const { plate } = parse(plateQuery, Object.fromEntries(url.searchParams));
	const file = workspaceOf(rt).sliced(params.id!, plate);
	return new Response(new Uint8Array(fs.readFileSync(file.path)), {
		headers: {
			'content-type': 'model/3mf',
			'content-disposition': `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			'cache-control': 'no-store'
		}
	});
});
