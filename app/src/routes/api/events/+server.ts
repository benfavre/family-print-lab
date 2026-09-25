import type { RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import type { ChangeEvent } from '$lib/server/lab';
import type { TaskInfo } from '$lib/shared/tasks';

/**
 * Server-sent events: workspace changes, background task progress and (throttled) live printer status,
 * so every open tab stays in sync.
 */
export const GET: RequestHandler = ({ request }) => {
	const rt = runtime();
	const encoder = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			};
			const onChange = (e: ChangeEvent) => send('change', e);
			let pending: NodeJS.Timeout | null = null;
			const onPrinter = () => {
				if (pending) return;
				pending = setTimeout(() => {
					pending = null;
					send('printer', rt.printerStatus());
				}, 750);
			};
			const onTask = (t: TaskInfo) => send('task', t);
			const onTaskRemoved = (id: string) => send('task-removed', { id });
			rt.lab.events.on('change', onChange);
			rt.tasks.events.on('task', onTask);
			rt.tasks.events.on('removed', onTaskRemoved);
			rt.printer?.on('update', onPrinter);
			const keepalive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					cleanup();
				}
			}, 20_000);
			send('hello', {
				changeId: rt.lab.changeId(),
				printer: rt.printerStatus(),
				tasks: rt.tasks.list()
			});
			cleanup = () => {
				clearInterval(keepalive);
				if (pending) clearTimeout(pending);
				rt.lab.events.off('change', onChange);
				rt.tasks.events.off('task', onTask);
				rt.tasks.events.off('removed', onTaskRemoved);
				rt.printer?.off('update', onPrinter);
			};
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			cleanup();
		}
	});
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
