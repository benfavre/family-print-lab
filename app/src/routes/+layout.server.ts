import { runtime } from '$lib/server/runtime';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const rt = runtime();
	return {
		workspace: rt.lab.snapshot(),
		printer: rt.printerStatus(),
		ai: rt.aiSummary()
	};
};
