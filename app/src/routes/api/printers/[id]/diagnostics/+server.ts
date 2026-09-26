import { api } from '$lib/server/http';

/** The printer's last report and versions without serial numbers or addresses, as a download. */
export const GET = api(({ params }, rt) => {
	const data = rt.printers.diagnostics(params.id!);
	return new Response(JSON.stringify(data, null, '\t'), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="printer-${data.model}-diagnostics.json"`
		}
	});
});
