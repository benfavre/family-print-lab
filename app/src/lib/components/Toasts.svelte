<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	const { ui } = useApp();
</script>

<div class="toasts" role="status" aria-live="polite">
	{#each ui.toasts as t (t.id)}
		<div class="toast {t.tone}" role={t.tone === 'error' ? 'alert' : undefined}>{t.message}</div>
	{/each}
</div>
