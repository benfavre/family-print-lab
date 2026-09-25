<script lang="ts">
	export interface Tile {
		label: string;
		value: string | number;
		p?: number;
		tone: string;
	}
	let { items, label }: { items: Tile[]; label: string } = $props();
</script>

<dl class="pipeline" aria-label={label}>
	{#each items as t (t.label)}
		<div class="stat t-{t.tone}">
			<dt>{t.label}</dt>
			<dd>{t.value}</dd>
			<span class="bar" style:--p={t.p ?? 0} aria-hidden="true"></span>
		</div>
	{/each}
</dl>
