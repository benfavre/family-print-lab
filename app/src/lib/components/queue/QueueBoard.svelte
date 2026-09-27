<script lang="ts">
	import { tick } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { duration } from '$lib/client/format';
	import { open, queueActions, STATUS_LABEL, STATUS_TONE } from '$lib/client/modules/queue/actions';
	import { modelShort } from '$lib/shared/printers/models';
	import type { QueueItemView, QueuePrinterView, QueueView } from '$lib/shared/queue';
	import StatusPill from '$lib/components/StatusPill.svelte';

	// One column per printer plus "Any printer". Drag items to reorder or move them between columns;
	// with the keyboard, focus an item's handle and use Alt+↑/↓ (order) or Alt+←/→ (column).
	let { view }: { view: QueueView } = $props();
	const { lab } = useApp();
	const act = queueActions(lab);

	type Column = { id: string | null; printer: QueuePrinterView | null };
	const columns = $derived<Column[]>([
		{ id: null, printer: null },
		...view.printers.map((p) => ({ id: p.printerId, printer: p }))
	]);
	const itemsIn = (id: string | null) => open(view).filter((i) => i.printerId === id);
	const printingOn = (id: string) =>
		view.items.filter((i) => i.status === 'sent' && i.printerId === id);
	const movable = (i: QueueItemView) => i.status !== 'dispatching';

	let dragging = $state<string | null>(null);
	let over = $state<string | null>(null);

	/** Moves an item into a column, before another item (or at the end). */
	async function place(itemId: string, column: string | null, before: string | null) {
		const ids = itemsIn(column)
			.map((i) => i.id)
			.filter((id) => id !== itemId);
		const at = before ? ids.indexOf(before) : -1;
		ids.splice(at < 0 ? ids.length : at, 0, itemId);
		await act.reorder(column, ids);
		await tick();
		document.querySelector<HTMLElement>(`[data-item="${itemId}"] .handle`)?.focus();
	}
	function drop(column: string | null, before: string | null) {
		const id = dragging;
		dragging = null;
		over = null;
		if (id && id !== before) void place(id, column, before);
	}
	function keys(e: KeyboardEvent, item: QueueItemView, column: string | null) {
		if (!e.altKey || !e.key.startsWith('Arrow')) return;
		e.preventDefault();
		const list = itemsIn(column);
		const at = list.findIndex((i) => i.id === item.id);
		if (e.key === 'ArrowUp' && at > 0) void place(item.id, column, list[at - 1].id);
		if (e.key === 'ArrowDown' && at < list.length - 1)
			void place(item.id, column, list[at + 2]?.id ?? null);
		const c = columns.findIndex((x) => x.id === column);
		const to =
			e.key === 'ArrowLeft' ? columns[c - 1] : e.key === 'ArrowRight' ? columns[c + 1] : null;
		if (to) void place(item.id, to.id, null);
	}
	const toggleAuto = (p: QueuePrinterView) =>
		act.printer(
			p.printerId,
			{ autoDispatch: !p.autoDispatch },
			p.autoDispatch ? 'Starts only when you press Start next.' : 'Starts queued jobs by itself.'
		);
	const togglePause = (p: QueuePrinterView) =>
		act.printer(p.printerId, { paused: !p.paused }, p.paused ? 'Queue resumed.' : 'Queue paused.');
</script>

<div class="board">
	{#each columns as col (col.id ?? 'any')}
		{@const items = itemsIn(col.id)}
		{@const p = col.printer}
		<section
			class="panel column"
			class:over={over === `col:${col.id}`}
			aria-label={p ? p.name : 'Any printer'}
			data-column={col.id ?? 'any'}
			ondragover={(e) => {
				if (!dragging) return;
				e.preventDefault();
				over = `col:${col.id}`;
			}}
			ondragleave={() => (over = null)}
			ondrop={(e) => {
				e.preventDefault();
				drop(col.id, null);
			}}
		>
			<header class="col-head">
				<div>
					<h2>{p ? p.name : 'Any printer'}</h2>
					<small
						>{p
							? `${modelShort(p.model)} · ${p.blocked ?? 'Ready for the next job'}`
							: 'The first free printer the file was sliced for'}</small
					>
				</div>
				<span class="count">{items.length}</span>
			</header>
			{#if p}
				<div class="col-acts">
					{#if p.plateClearNeeded}
						<button
							class="mini primary-mini"
							onclick={() =>
								act.printer(
									p.printerId,
									{ plateCleared: true },
									'Thanks. The next print can start.'
								)}>Plate is clear</button
						>
					{/if}
					<button
						class="mini"
						onclick={() => act.printer(p.printerId, { startNext: true }, 'Sending the next job…')}
						>Start next</button
					>
					<button class="mini" aria-pressed={p.paused} onclick={() => togglePause(p)}
						>{p.paused ? 'Resume' : 'Pause'}</button
					>
					<label class="check auto"
						><input type="checkbox" checked={p.autoDispatch} onchange={() => toggleAuto(p)} /> Start by
						itself</label
					>
				</div>
				{#each printingOn(p.printerId) as item (item.id)}
					<p class="now">▶ Printing {item.title}</p>
				{/each}
			{/if}
			{#if items.length}
				<ol class="items">
					{#each items as item (item.id)}
						<li
							data-item={item.id}
							class:dragging={dragging === item.id}
							class:over={over === item.id}
							draggable={movable(item)}
							ondragstart={(e) => {
								dragging = item.id;
								e.dataTransfer?.setData('text/plain', item.id);
							}}
							ondragend={() => {
								dragging = null;
								over = null;
							}}
							ondragover={(e) => {
								if (!dragging) return;
								e.preventDefault();
								e.stopPropagation();
								over = item.id;
							}}
							ondrop={(e) => {
								e.preventDefault();
								e.stopPropagation();
								drop(col.id, item.id);
							}}
						>
							<button
								class="handle"
								disabled={!movable(item)}
								aria-label="Move {item.title} (Alt+arrow keys)"
								title="Drag, or Alt+arrow keys"
								onkeydown={(e) => keys(e, item, col.id)}>⋮⋮</button
							>
							<div class="what">
								<b>{item.title}</b>
								<small
									>{item.minutes ? duration(item.minutes) : 'No estimate'}{!p && item.slicedFor
										? ` · for ${modelShort(item.slicedFor)}`
										: ''}{item.requirePlateClear ? '' : ' · no plate check'}</small
								>
								{#if item.status === 'failed' || (item.status === 'held' && item.reason)}
									<small class="why bad">{item.reason}</small>
								{:else if item.waitingFor && item.status === 'waiting'}
									<small class="why">{item.waitingFor}</small>
								{/if}
							</div>
							<div class="acts">
								<StatusPill status={STATUS_TONE[item.status]} label={STATUS_LABEL[item.status]} />
								{#if item.status === 'waiting'}
									<button class="mini" onclick={() => act.hold(item)}>Hold</button>
								{:else if item.status === 'held' || item.status === 'failed'}
									<button class="mini" onclick={() => act.release(item)}
										>{item.status === 'failed' ? 'Try again' : 'Release'}</button
									>
								{/if}
								{#if item.status !== 'dispatching'}
									<button
										class="mini icon"
										aria-label="Take {item.title} out of the queue"
										title="Take out of the queue"
										onclick={() => act.remove(item)}>✕</button
									>
								{/if}
							</div>
						</li>
					{/each}
				</ol>
			{:else}
				<p class="panel-empty">{dragging ? 'Drop here.' : 'Nothing queued.'}</p>
			{/if}
		</section>
	{/each}
</div>

<style>
	.board {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
		gap: 12px;
		align-items: start;
	}
	.column.over {
		border-color: var(--cyan);
	}
	.col-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 8px;
	}
	.col-head h2 {
		margin: 0;
		font-size: 15px;
	}
	.col-head small {
		color: var(--muted);
		font-size: 12px;
	}
	.count {
		font-size: 12px;
		color: var(--dim);
	}
	.col-acts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-bottom: 8px;
	}
	.auto {
		font-size: 12px;
		color: var(--muted);
	}
	.now {
		margin: 0 0 8px;
		font-size: 12.5px;
		color: var(--amber);
	}
	.items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.items li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 4px 8px;
		align-items: center;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.02);
		font-size: 13px;
	}
	.items li.dragging {
		border-style: dashed;
		opacity: 0.6;
	}
	.items li.over {
		box-shadow: 0 -2px 0 var(--cyan);
	}
	.handle {
		border: 0;
		background: transparent;
		color: var(--dim);
		cursor: grab;
		padding: 4px;
		letter-spacing: -2px;
	}
	.what {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.what small {
		color: var(--dim);
		font-size: 12px;
	}
	.why {
		color: var(--muted) !important;
	}
	.why.bad {
		color: var(--err-text) !important;
	}
	.acts {
		grid-column: 2;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
</style>
