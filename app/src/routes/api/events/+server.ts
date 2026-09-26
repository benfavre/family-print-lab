import type { RequestHandler } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import type { ChangeEvent } from '$lib/server/lab';
import type { TaskInfo } from '$lib/shared/tasks';

/**
 * Server-sent events: workspace changes, background task progress, live printer status (one printer per
 * event, throttled per printer) and module live channels, so every open tab stays in sync.
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
			const pending = new Map<string, NodeJS.Timeout>();
			const onPrinter = (id: string) => {
				if (pending.has(id)) return;
				pending.set(
					id,
					setTimeout(() => {
						pending.delete(id);
						// Removed meanwhile: the workspace change tells the tab.
						const status = rt.printers.statuses().find((p) => p.id === id);
						if (status) send('printer', status);
					}, 750)
				);
			};
			const onLive = (message: { channel: string; data: unknown }) => send('live', message);
			const onTask = (t: TaskInfo) => send('task', t);
			const onTaskRemoved = (id: string) => send('task-removed', { id });
			const onCloud = (status: unknown) => send('cloud', status);
			rt.cloud?.on('status', onCloud);
			rt.lab.events.on('change', onChange);
			rt.tasks.events.on('task', onTask);
			rt.tasks.events.on('removed', onTaskRemoved);
			rt.printers.on('update', onPrinter);
			rt.live.on('live', onLive);
			const keepalive = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
				} catch {
					cleanup();
				}
			}, 20_000);
			send('hello', {
				changeId: rt.lab.changeId(),
				printers: rt.printers.statuses(),
				printer: rt.printerStatus(),
				cloud: rt.cloud?.status() ?? null,
				tasks: rt.tasks.list()
			});
			cleanup = () => {
				clearInterval(keepalive);
				for (const timer of pending.values()) clearTimeout(timer);
				rt.lab.events.off('change', onChange);
				rt.tasks.events.off('task', onTask);
				rt.tasks.events.off('removed', onTaskRemoved);
				rt.printers.off('update', onPrinter);
				rt.live.off('live', onLive);
				rt.cloud?.off('status', onCloud);
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
