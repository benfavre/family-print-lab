<script lang="ts">
	import { importWindows } from './state.svelte';
</script>

<button
	class="import-button"
	title="Import a model from a link (Printables, Thingiverse, MakerWorld)"
	aria-label="Import a model from a link"
	onclick={() => importWindows.openLink()}
>
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
		><path
			d="M8 2.5v7M5 6.8l3 3l3-3M3 11.5v1.5h10v-1.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/></svg
	><span class="import-label">Import</span>
</button>

<style>
	.import-button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 10px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		font: 500 12.5px var(--sans);
		cursor: pointer;
	}
	.import-button:hover {
		color: var(--text);
		border-color: var(--line-strong);
	}
	@media (max-width: 1100px) {
		.import-label {
			display: none;
		}
	}
	/* Phones: no room in the top bar; the palette and the Projects page import links too. */
	@media (max-width: 700px) {
		.import-button {
			display: none;
		}
	}
</style>
