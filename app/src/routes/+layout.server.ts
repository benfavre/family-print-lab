import { runtime } from '$lib/server/runtime';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const rt = runtime();
	const kid = locals.kid;
	return {
		/** Set while this browser is in kid mode. */
		kid: kid ? { id: kid.id, name: kid.name, level: kid.kid } : null,
		workspace: rt.lab.snapshot(),
		printer: rt.printerStatus(),
		ai: rt.aiSummary()
	};
};
