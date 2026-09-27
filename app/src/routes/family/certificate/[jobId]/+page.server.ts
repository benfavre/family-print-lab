import { error } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import type { PageServerLoad } from './$types';

/** A printable certificate for a finished print. */
export const load: PageServerLoad = ({ params }) => {
	const certificate = runtime().module('kids')?.certificate(params.jobId);
	if (!certificate) error(404, 'There is no certificate for that print: it has to finish first.');
	return { certificate };
};
