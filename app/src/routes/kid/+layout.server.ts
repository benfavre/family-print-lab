import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/** Kid pages only make sense in kid mode; grown-ups start it from the profile picker. */
export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.kid) redirect(303, '/');
};
