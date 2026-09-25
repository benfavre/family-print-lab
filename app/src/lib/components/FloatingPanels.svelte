<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import FloatingPanel from './FloatingPanel.svelte';

	// Drafts and editors dock along the bottom-right edge, newest on the right, like mail drafts.
	const { ui } = useApp();
</script>

{#if ui.panels.length}
	<div class="panel-dock" aria-label="Open panels">
		{#each ui.panels as panel (panel.key)}
			<FloatingPanel {panel} />
		{/each}
	</div>
{/if}

<style>
	.panel-dock {
		position: fixed;
		right: 20px;
		bottom: 0;
		left: 20px;
		z-index: 45;
		display: flex;
		justify-content: flex-end;
		align-items: flex-end;
		gap: 12px;
		pointer-events: none;
	}
	@media (max-width: 700px) {
		.panel-dock {
			left: 0;
			right: 0;
			bottom: calc(62px + env(safe-area-inset-bottom));
			flex-direction: column;
			align-items: stretch;
			gap: 0;
		}
	}
</style>
