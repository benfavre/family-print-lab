<script lang="ts">
	let {
		status,
		label = status,
		live = false
	}: { status: string; label?: string; live?: boolean } = $props();
	const tone: Record<string, string> = { Queued: 'Idea', Succeeded: 'Done' };
</script>

<span class="status-pill {tone[status] ?? status}" class:live
	><i aria-hidden="true"></i>{label}</span
>
