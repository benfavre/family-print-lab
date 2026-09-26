import { redirect } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/** The old single-printer page: now the first printer's page, or the printers overview. */
export const GET: RequestHandler = () => {
	const primary = runtime().printers.primary();
	redirect(308, primary ? `/printers/${primary.id}` : '/printers');
};
