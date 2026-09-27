import { api } from '$lib/server/http';
import { needKids } from '$lib/server/modules/kids/api';

/** No photo for this finished print: stop inviting one. */
export const POST = api(({ params }, rt) => {
	needKids(rt).dismissPhoto(params.jobId!);
	return { ok: true };
});
