<script lang="ts">
	import { goto } from '$app/navigation';
	import { useApp, type MenuItem } from '$lib/client/app.svelte';

	const { ui } = useApp();
	let menu = $state<HTMLElement>();
	let pos = $state({ left: 0, top: 0 });

	$effect(() => {
		if (!ui.menu || !menu) return;
		const r = menu.getBoundingClientRect();
		pos = {
			left: Math.max(8, Math.min(ui.menu.x, innerWidth - r.width - 8)),
			top: Math.max(
				8,
				Math.min(ui.menu.above ? ui.menu.y - r.height : ui.menu.y, innerHeight - r.height - 8)
			)
		};
		menu.querySelector<HTMLElement>('button')?.focus();
	});

	function close(refocus = false) {
		const back = ui.menu?.returnTo;
		ui.menu = null;
		if (refocus) back?.focus();
	}
	function choose(item: MenuItem) {
		close();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- menu hrefs are built with resolve() in actions.ts
		if (item.href) goto(item.href);
		else item.run?.();
	}
	function keys(e: KeyboardEvent) {
		const items = [...(menu?.querySelectorAll<HTMLElement>('button') ?? [])];
		const at = items.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'Escape') {
			e.preventDefault();
			close(true);
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
		} else if (e.key === 'Tab') close();
	}
</script>

<svelte:window
	onpointerdown={(e) => {
		if (ui.menu && !(e.target as HTMLElement).closest('.context-menu')) close();
	}}
	onscroll={() => ui.menu && close()}
	onresize={() => ui.menu && close()}
/>

{#if ui.menu}
	<div
		bind:this={menu}
		class="popover context-menu"
		role="menu"
		aria-label="Actions"
		tabindex="-1"
		style:left="{pos.left}px"
		style:top="{pos.top}px"
		onkeydown={keys}
	>
		<div class="ctx-title">{ui.menu.title}</div>
		{#each ui.menu.items as item, i (i)}
			{#if item.separator}<hr />
			{:else if item.heading}<div class="ctx-label">{item.label}</div>
			{:else if item.dot}
				<button
					role="menuitemradio"
					aria-checked={!!item.checked}
					class="ctx-status {item.dot}"
					onclick={() => choose(item)}><i aria-hidden="true"></i>{item.label}</button
				>
			{:else}
				<button role="menuitem" class:danger-item={item.danger} onclick={() => choose(item)}
					>{item.label}</button
				>
			{/if}
		{/each}
	</div>
{/if}
