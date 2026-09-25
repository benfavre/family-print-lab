<script lang="ts">
	import { CATEGORIES, CATEGORY_GLYPH, PROJECT_STATUSES } from '$lib/shared/domain';
	import { useApp, type MenuItem } from '$lib/client/app.svelte';
	import { openMenu } from '$lib/client/actions';

	let { visible }: { visible: string[] } = $props();
	const app = useApp();
	const { lab, ui } = app;
	const count = $derived(ui.selected.length);
	const hidden = $derived(ui.selected.filter((id) => !visible.includes(id)).length);
	const titles = $derived(
		ui.selected.map((id) => lab.project(id)?.title).filter(Boolean) as string[]
	);
	let busy = $state(false);

	async function apply(action: string, value?: string, success?: string) {
		busy = true;
		const res = await lab.call<{ count: number; created: string[] }>(
			'POST',
			'/api/projects/bulk',
			{ ids: ui.selected, action, value },
			success
		);
		busy = false;
		if (res) ui.selected = action === 'duplicate' ? res.created : [];
		return res;
	}

	function menu(e: MouseEvent, title: string, items: MenuItem[]) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		openMenu(app, title, items, r.left, r.top - 8, e.currentTarget as HTMLElement, true);
	}
	const plural = (n: number) => `${n} ${n === 1 ? 'project' : 'projects'}`;

	async function remove() {
		const jobs = lab.ws.jobs.filter((j) => ui.selected.includes(j.projectId)).length;
		const models = lab.ws.models.filter((m) => ui.selected.includes(m.projectId)).length;
		const detail = [
			jobs && `${jobs} print ${jobs === 1 ? 'job' : 'jobs'}`,
			models && `${models} ${models === 1 ? 'model' : 'models'}`
		]
			.filter(Boolean)
			.join(' and ');
		if (
			await ui.ask(
				`Delete ${plural(count)}?`,
				`This removes ${titles.slice(0, 5).join(', ')}${titles.length > 5 ? ` and ${titles.length - 5} more` : ''}${detail ? `, with their ${detail}` : ''}. Filament used by their prints goes back to the spools. Backups keep a copy.`
			)
		)
			await apply('delete', undefined, `Deleted ${plural(count)}.`);
	}

	function ask() {
		ui.assistantAsk?.(
			`Help me plan these projects together: ${titles.map((t) => `“${t}”`).join(', ')}. What should we print first, which could share a plate or a filament, and what is still missing before we can print them?`
		);
	}
</script>

{#if count}
	<div class="bulk-bar" role="toolbar" aria-label="Selected projects">
		<span class="count"
			><b>{count}</b> selected{#if hidden}<small> · {hidden} hidden by filters</small>{/if}</span
		>
		{#if count < visible.length}
			<button
				type="button"
				class="mini select-all"
				onclick={() => (ui.selected = [...new Set([...ui.selected, ...visible])])}
				>Select all {visible.length}</button
			>
		{/if}
		<span class="sep" aria-hidden="true"></span>
		<button
			type="button"
			class="mini"
			disabled={busy}
			onclick={(e) =>
				menu(
					e,
					'Move to',
					PROJECT_STATUSES.map((s) => ({
						label: s,
						dot: s,
						run: () => apply('status', s, `Moved ${plural(count)} to ${s}.`)
					}))
				)}>Progress ▾</button
		>
		<button
			type="button"
			class="mini"
			disabled={busy}
			onclick={(e) =>
				menu(
					e,
					'For',
					lab.ws.profiles.map((p) => ({
						label: p.name,
						run: () => apply('owner', p.id, `Gave ${plural(count)} to ${p.name}.`)
					}))
				)}>Person ▾</button
		>
		<button
			type="button"
			class="mini"
			disabled={busy}
			onclick={(e) =>
				menu(
					e,
					'Category',
					CATEGORIES.map((c) => ({
						label: `${CATEGORY_GLYPH[c]}  ${c}`,
						run: () => apply('category', c, `Filed ${plural(count)} under ${c}.`)
					}))
				)}>Category ▾</button
		>
		<button
			type="button"
			class="mini"
			disabled={busy}
			onclick={() => apply('pin', undefined, `Pinned ${plural(count)}.`)}>Pin</button
		>
		<button
			type="button"
			class="mini"
			disabled={busy}
			onclick={() => apply('unpin', undefined, `Unpinned ${plural(count)}.`)}>Unpin</button
		>
		<button
			type="button"
			class="mini"
			disabled={busy}
			onclick={() => apply('duplicate', undefined, `Duplicated ${plural(count)}.`)}
			>Duplicate</button
		>
		<button type="button" class="mini ai" disabled={busy} onclick={ask}>✦ Plan together</button>
		<button type="button" class="mini danger-mini" disabled={busy} onclick={remove}>Delete…</button>
		<span class="sep" aria-hidden="true"></span>
		<button
			type="button"
			class="mini icon"
			aria-label="Clear selection (Esc)"
			title="Clear selection (Esc)"
			onclick={() => (ui.selected = [])}>×</button
		>
	</div>
{/if}

<style>
	.bulk-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 22px;
		z-index: 40;
		width: fit-content;
		margin: 0 auto;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: center;
		max-width: calc(100vw - 32px);
		padding: 8px 10px 8px 16px;
		border-radius: 14px;
		border: 1px solid rgb(var(--c1) / 0.45);
		background: var(--menu);
		box-shadow:
			0 18px 50px rgb(var(--lo) / 0.5),
			0 0 0 4px rgb(var(--c1) / 0.08);
		animation: rise 0.18s ease-out;
	}
	.count {
		font-size: 13px;
		color: var(--text-2);
		margin-right: 4px;
		white-space: nowrap;
	}
	.count b {
		color: var(--cyan);
		font-size: 15px;
	}
	.count small {
		color: var(--dim);
	}
	.select-all {
		background: transparent;
		box-shadow: none;
		color: var(--cyan);
	}
	.sep {
		width: 1px;
		height: 20px;
		background: var(--line-strong);
		margin: 0 4px;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bulk-bar {
			animation: none;
		}
	}
</style>
