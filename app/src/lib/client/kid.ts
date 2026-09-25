// Kid mode on the client: where each thing a child made stands, in words a child understands.
import type { PrintRequest, Project } from '$lib/shared/domain';
import { kidTemplate } from '$lib/shared/kid';
import type { LabStore } from './app.svelte';

export type ThingState =
	'ready' | 'waiting' | 'approved' | 'printing' | 'made' | 'failed' | 'declined';

export interface ThingStatus {
	state: ThingState;
	icon: string;
	label: string;
	/** 0..1 while printing, when known. */
	progress: number | null;
	request: PrintRequest | null;
	/** Whether the child can ask (again) for it to be printed. */
	canAsk: boolean;
}

const WORDS: Record<ThingState, [string, string]> = {
	ready: ['✨', 'Ready to ask'],
	waiting: ['⏳', 'Waiting for a grown-up'],
	approved: ['👍', 'Yes! It’s coming soon'],
	printing: ['🖨️', 'Printing now'],
	made: ['🎉', 'Made it!'],
	failed: ['🔧', 'The print didn’t work. A grown-up can try again'],
	declined: ['💬', 'Not this time']
};

export function thingStatus(lab: LabStore, projectId: string, now = Date.now()): ThingStatus {
	const request = lab.ws.printRequests.find((r) => r.projectId === projectId) ?? null;
	const job = request?.jobId ? lab.ws.jobs.find((j) => j.id === request.jobId) : undefined;
	let state: ThingState = 'ready';
	if (request?.status === 'Waiting') state = 'waiting';
	else if (request?.status === 'Declined') state = 'declined';
	else if (request?.status === 'Approved')
		state =
			job?.status === 'Printing'
				? 'printing'
				: job?.status === 'Succeeded'
					? 'made'
					: job?.status === 'Failed' || job?.status === 'Cancelled'
						? 'failed'
						: 'approved';
	const [icon, label] = WORDS[state];
	return {
		state,
		icon,
		label,
		progress: job && state === 'printing' ? lab.progress(job, now) : null,
		request,
		canAsk: ['ready', 'declined', 'made', 'failed'].includes(state)
	};
}

/** The template a kid thing was made from (its model's origin is `kid:<template>`). */
export function thingTemplate(lab: LabStore, project: Project) {
	const model = lab.ws.models.find((m) => m.projectId === project.id);
	const origin = model?.versions.find((v) => v.id === model.currentVersionId)?.origin ?? '';
	return { model, template: origin.startsWith('kid:') ? kidTemplate(origin.slice(4)) : undefined };
}

/**
 * How far to zoom into a stored thumbnail (which shows the whole 256 mm bed, to scale) so a small part
 * fills a card. Parts sit in the middle of the bed, so the zoom is centred.
 */
export function thumbZoom(v: { sizeX: number; sizeY: number; sizeZ: number }) {
	return Math.min(3, Math.max(1, 256 / (Math.max(v.sizeX, v.sizeY, v.sizeZ) * 1.8)));
}
