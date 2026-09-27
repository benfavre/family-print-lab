// slicer-ui: the slicer workspace's way in from a queued job (its model version as a slicer project).
import { defineUi } from '../../registry';
import JobSlicerLink from '$lib/components/slicer/JobSlicerLink.svelte';

export default defineUi({
	key: 'slicer-ui',
	jobPanels: [
		{
			id: 'open-in-slicer',
			order: 45,
			component: JobSlicerLink,
			show: (job) => job.status === 'Queued' && !!job.modelVersionId && !job.sliced
		}
	]
});
