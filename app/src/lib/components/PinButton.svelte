<script lang="ts">
	import type { Project } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';

	let { project }: { project: Project } = $props();
	const app = useApp();
</script>

<button
	class="pin-button"
	class:on={project.pinned}
	aria-pressed={project.pinned}
	aria-label="{project.pinned ? 'Unpin' : 'Pin'} {project.title}"
	title={project.pinned ? 'Unpin' : 'Pin to top'}
	onclick={(e) => {
		e.stopPropagation();
		e.preventDefault();
		actions(app).togglePin(project);
	}}
>
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
		><path
			fill="currentColor"
			d="M9.8 1.4a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1 .25l-2.2 2.2.3 2.6a1 1 0 0 1-.28.83l-.5.5a.7.7 0 0 1-1 0L6.7 10.8l-3.9 3.9a.6.6 0 0 1-.85-.85l3.9-3.9-2.5-2.5a.7.7 0 0 1 0-1l.5-.5a1 1 0 0 1 .83-.28l2.6.3 2.2-2.2a1 1 0 0 1 .25-1z"
		/></svg
	>
</button>
