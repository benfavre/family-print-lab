import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { eq } from 'drizzle-orm';
import { projects } from '$lib/server/db/schema';

/** The original designer and licence, kept even after the project description is edited. */
export const GET = api(({ params }, rt) => {
	if (!rt.db.select({ id: projects.id }).from(projects).where(eq(projects.id, params.id!)).get())
		throw new AppError(404, 'That project no longer exists.');
	return { sources: rt.module('model-import')?.imports.sources(params.id!) ?? [] };
});
