<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import Modal from './Modal.svelte';

	const { ui } = useApp();
	function answer(ok: boolean) {
		ui.confirm?.resolve(ok);
		ui.confirm = null;
	}
</script>

{#if ui.confirm}
	<Modal id="confirm" onclose={() => answer(false)}>
		<h2 id="confirm-title">{ui.confirm.title}</h2>
		<p>{ui.confirm.text}</p>
		<div class="confirm-actions">
			<!-- svelte-ignore a11y_autofocus -->
			<button class="secondary" autofocus onclick={() => answer(false)}>Keep it</button>
			<button class="danger-solid" onclick={() => answer(true)}>{ui.confirm.ok}</button>
		</div>
	</Modal>
{/if}
