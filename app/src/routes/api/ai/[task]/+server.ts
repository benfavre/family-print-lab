import { json, type RequestHandler } from '@sveltejs/kit';
import { readJson } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';

const asAppError = (error: unknown) =>
	error instanceof AppError
		? error
		: (console.error(error), new AppError(500, 'The assistant failed unexpectedly.'));

/** Structured suggestions (ideas, diagnose, settings, checklist) as JSON, or a streamed chat reply as text. */
export const POST: RequestHandler = async ({ request, params }) => {
	const rt = runtime();
	let input: Record<string, unknown>;
	try {
		input = (await readJson(request, 12_000_000)) as Record<string, unknown>;
	} catch (error) {
		const e = asAppError(error);
		return json({ error: e.message }, { status: e.status });
	}
	if (params.task !== 'chat') {
		if (!rt.ai.tasks.includes(params.task!))
			return json({ error: 'Unknown assistant task.' }, { status: 404 });
		try {
			return json(
				await rt.ai.run(params.task!, rt.lab.snapshot(), rt.printerStatus(), input, request.signal)
			);
		} catch (error) {
			const e = asAppError(error);
			return json({ error: e.message }, { status: e.status });
		}
	}
	// Chat: fail fast with a JSON error, otherwise stream plain text as it arrives.
	const encoder = new TextEncoder();
	let firstChunk: ((ok: boolean) => void) | null = null;
	const started = new Promise<boolean>((resolve) => (firstChunk = resolve));
	let failure: AppError | null = null;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				await rt.ai.chat(
					rt.lab.snapshot(),
					rt.printerStatus(),
					input.messages,
					(text) => {
						firstChunk?.(true);
						firstChunk = null;
						controller.enqueue(encoder.encode(text));
					},
					request.signal
				);
				firstChunk?.(true);
			} catch (error) {
				failure = asAppError(error);
				if (firstChunk) firstChunk(false);
				else controller.enqueue(encoder.encode(`\n\n(Stopped: ${failure.message})`));
			}
			controller.close();
		}
	});
	if (!(await started)) {
		const e = failure ?? new AppError(500, 'The assistant failed.');
		return json({ error: e.message }, { status: e.status });
	}
	return new Response(stream, {
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
};
