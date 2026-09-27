import { api } from '$lib/server/http';
import { profilesOf } from '$lib/server/modules/slicer-profiles/http';

/** The preset as Bambu Studio's .json; ?bundle=1 as a .bbscfg (printer) or .bbsflmt (filament). */
export const GET = api(({ params, url }, rt) => {
	const file = profilesOf(rt).exportUser(params.id!, url.searchParams.get('bundle') === '1');
	return new Response(new Uint8Array(file.data), {
		headers: {
			'content-type': file.type,
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
		}
	});
});
