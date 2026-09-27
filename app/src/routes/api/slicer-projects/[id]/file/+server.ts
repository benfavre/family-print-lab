import fs from 'node:fs';
import { api } from '$lib/server/http';
import { projectStore } from '$lib/server/modules/slicer-3mf/module';

/** The project file itself, to open in Bambu Studio or OrcaSlicer. */
export const GET = api(({ params }, rt) => {
	const file = projectStore(rt).file(params.id!);
	return new Response(new Uint8Array(fs.readFileSync(file.path)), {
		headers: {
			'content-type': 'model/3mf',
			'content-disposition': `attachment; filename="${file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			'cache-control': 'no-store'
		}
	});
});
