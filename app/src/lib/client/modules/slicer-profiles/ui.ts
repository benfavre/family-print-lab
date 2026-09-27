// slicer-profiles: Settings → Slicer profiles, the job's Slicer settings and the spool's slicer preset.
import { defineUi } from '../../registry';
import ProfilesSection from '$lib/components/profiles/ProfilesSection.svelte';
import JobSlicerPanel from '$lib/components/profiles/JobSlicerPanel.svelte';
import SpoolPresetField from '$lib/components/profiles/SpoolPresetField.svelte';

export default defineUi({
	key: 'slicer-profiles',
	settingsSections: [
		{
			id: 'slicer-profiles',
			order: 20,
			group: 'printing',
			title: 'Slicer profiles',
			component: ProfilesSection
		}
	],
	jobPanels: [
		{
			id: 'slicer-settings',
			order: 50,
			component: JobSlicerPanel,
			show: (job) => job.status === 'Queued'
		}
	],
	spoolFormFields: [{ id: 'slicer-preset', order: 50, component: SpoolPresetField }]
});
