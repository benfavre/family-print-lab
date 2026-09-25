import { runtime } from '$lib/server/runtime';
import { exportWorkspace } from '$lib/server/portability';

export const GET = () => {
	const date = new Date().toISOString().slice(0, 10);
	return new Response(JSON.stringify(exportWorkspace(runtime().lab), null, 2), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="family-print-lab-${date}.json"`,
			'cache-control': 'no-store'
		}
	});
};
