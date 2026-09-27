<script lang="ts">
	import type { Job } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import Modal from '../Modal.svelte';
	import GcodePreview from './GcodePreview.svelte';

	// On a job card with a sliced file: a button that opens the plate's toolpaths. While the job prints,
	// the preview follows the printer's layer.
	let { job }: { job: Job } = $props();
	const { lab } = useApp();
	let open = $state(false);
	const sliced = $derived(job.sliced);
	const plate = $derived(
		sliced?.plates.find((p) => p.index === (job.dispatch?.plate ?? sliced.plate)) ?? null
	);
	const live = $derived(job.status === 'Printing' ? lab.liveFor(job) : null);
	/**
	 * The dialog lives under <body>, not inside the card: job cards are draggable, and a drag to turn
	 * the view would otherwise pick up the whole card.
	 */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		// Moving an open modal dialog takes it out of the top layer; open it again where it now is.
		const dialog = node.querySelector('dialog');
		if (dialog?.open) {
			dialog.close();
			dialog.showModal();
		}
		return { destroy: () => node.remove() };
	}
</script>

{#if sliced && plate}
	<button
		type="button"
		class="mini gj-open"
		onclick={() => (open = true)}
		title="See every move of the sliced plate, layer by layer">◫ Toolpaths</button
	>
	{#if open}
		<div use:portal>
			<Modal id="gcode-preview" class="gcode-dialog" onclose={() => (open = false)}>
				<header class="dialog-top">
					<h2 id="gcode-preview-title">
						Toolpaths{sliced.plates.length > 1 ? ` · plate ${plate.index}` : ''}
					</h2>
					<button class="icon-button" aria-label="Close" onclick={() => (open = false)}>×</button>
				</header>
				<GcodePreview
					jobId={job.id}
					file={sliced.file}
					plate={plate.index}
					grams={plate.grams}
					liveLayer={live?.layer ?? null}
				/>
			</Modal>
		</div>
	{/if}
{/if}

<style>
	.gj-open {
		align-self: flex-start;
		justify-self: start;
		width: max-content;
		margin-top: 6px;
	}
	:global(dialog.gcode-dialog) {
		width: min(980px, calc(100% - 24px));
	}
</style>
