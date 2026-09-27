// Queue actions shared by the queue page, the printer panel and the send panel.
import type { LabStore } from '$lib/client/app.svelte';
import { sameModel } from '$lib/shared/printers/models';
import type { QueueItemView, QueueView } from '$lib/shared/queue';
import { queueStore } from './store.svelte';

type Body = Record<string, unknown>;

export function queueActions(lab: LabStore) {
	const call = async (method: string, path: string, body?: Body, success?: string) => {
		const res = await lab.call<{ queue?: QueueView }>(method, path, body, success);
		queueStore.adopt(res);
		return res;
	};
	return {
		add: (body: Body, success = 'Added to the queue.') => call('POST', '/api/queue', body, success),
		hold: (item: QueueItemView) =>
			call('PATCH', `/api/queue/${item.id}`, { hold: true }, 'On hold.'),
		release: (item: QueueItemView) =>
			call(
				'PATCH',
				`/api/queue/${item.id}`,
				{ hold: false },
				item.status === 'failed' ? 'It will be tried again.' : 'Released.'
			),
		remove: (item: QueueItemView) =>
			call('DELETE', `/api/queue/${item.id}`, undefined, 'Taken out of the queue.'),
		reorder: (printerId: string | null, ids: string[]) =>
			call('POST', '/api/queue/reorder', { printerId, ids }),
		printer: (printerId: string, body: Body, success?: string) =>
			call('POST', `/api/queue/printers/${printerId}`, body, success),
		settings: (body: Body) => call('PUT', '/api/queue/settings', body, 'Queue settings saved.')
	};
}

/** Items still to print, in queue order. */
export const open = (view: QueueView | null) =>
	(view?.items ?? []).filter((i) => i.status !== 'sent');

/** What a printer would take next: its own column first, then "any printer" items that fit. */
export function upNextFor(view: QueueView | null, printerId: string, model: string | undefined) {
	const items = open(view);
	return [
		...items.filter((i) => i.printerId === printerId),
		...items.filter(
			(i) => !i.printerId && (!i.slicedFor || !model || sameModel(i.slicedFor, model))
		)
	];
}

export const STATUS_LABEL: Record<QueueItemView['status'], string> = {
	waiting: 'Waiting',
	held: 'On hold',
	dispatching: 'Sending',
	sent: 'Printing',
	failed: 'Not sent'
};
export const STATUS_TONE: Record<QueueItemView['status'], string> = {
	waiting: 'Idea',
	held: 'Cancelled',
	dispatching: 'Printing',
	sent: 'Printing',
	failed: 'Failed'
};
