import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { AppError } from './validation';
import { runtime } from './runtime';

/** Reads a JSON body with a size limit. */
export async function readJson(request: Request, limit = 1_000_000): Promise<unknown> {
	if ((request.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json')
		throw new AppError(415, 'Send JSON.');
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > limit) throw new AppError(413, 'Request too large.');
	const text = await request.text();
	if (text.length > limit) throw new AppError(413, 'Request too large.');
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new AppError(400, 'Invalid JSON.');
	}
}

/** Wraps an API handler: maps AppError to JSON errors and returns the fresh workspace after writes. */
export function api(
	fn: (event: RequestEvent, rt: ReturnType<typeof runtime>) => unknown | Promise<unknown>
): RequestHandler {
	return async (event) => {
		try {
			const rt = runtime();
			const result = await fn(event, rt);
			if (result instanceof Response) return result;
			const write = event.request.method !== 'GET';
			return json(
				write
					? {
							...(result && typeof result === 'object' ? result : { result }),
							workspace: rt.lab.snapshot()
						}
					: result
			);
		} catch (error) {
			if (error instanceof AppError)
				return json({ error: error.message }, { status: error.status });
			const sqliteCode = (error as { code?: string }).code;
			if (sqliteCode?.startsWith('SQLITE_CONSTRAINT'))
				return json({ error: 'That change would break a link between records.' }, { status: 409 });
			console.error(error);
			return json({ error: 'Something went wrong on the server.' }, { status: 500 });
		}
	};
}
