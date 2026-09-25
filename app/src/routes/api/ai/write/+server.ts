import { json, type RequestHandler } from '@sveltejs/kit';
import { readJson } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';
import { writeRequest } from '$lib/server/ai/write';

const asAppError = (error: unknown) =>
	error instanceof AppError
		? error
		: (console.error(error), new AppError(500, 'The AI failed unexpectedly.'));

/** Streams a suggestion for a text field as plain text (the field is only changed when the user accepts it). */
export const POST: RequestHandler = async ({ request }) => {
	const rt = runtime();
	let req: ReturnType<typeof writeRequest>;
	try {
		req = writeRequest(await readJson(request, 50_000));
	} catch (error) {
		const e = asAppError(error);
		return json({ error: e.message }, { status: e.status });
	}
	const provider = rt.provider('ideas');
	const encoder = new TextEncoder();
	let first: ((ok: boolean) => void) | null = null;
	const started = new Promise<boolean>((resolve) => (first = resolve));
	let failure: AppError | null = null;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				await provider.chat({ ...req, signal: request.signal }, (text) => {
					first?.(true);
					first = null;
					controller.enqueue(encoder.encode(text));
				});
				first?.(true);
			} catch (error) {
				failure = asAppError(error);
				if (first) first(false);
				else controller.enqueue(encoder.encode(`\n\n(Stopped: ${failure.message})`));
			}
			controller.close();
		}
	});
	if (!(await started)) {
		const e = failure ?? new AppError(500, 'The AI failed.');
		return json({ error: e.message }, { status: e.status });
	}
	return new Response(stream, {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'x-ai-provider': provider.id
		}
	});
};
