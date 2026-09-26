<script lang="ts">
	import { resolve } from '$app/paths';
	import { duration, printerStateLabel, temp } from '$lib/client/format';
	import { ACTIVE_PRINTER_STATES, type PrinterStatus } from '$lib/shared/domain';

	// One printer at a glance on /printers: state, progress, temperatures and what is loaded.
	let { printer }: { printer: PrinterStatus } = $props();
	const s = $derived(printer.state ?? null);
	const active = $derived(!!printer.connected && !!s && ACTIVE_PRINTER_STATES.has(s.gcodeState));
	const label = $derived(printerStateLabel(printer));
	const percent = $derived(
		active && s?.percent !== null && s?.percent !== undefined ? s.percent : null
	);
	const trays = $derived([...(s?.ams ?? []).flatMap((u) => u.trays), ...(s?.externalSpools ?? [])]);
	const R = 22;
	const C = 2 * Math.PI * R;
</script>

<a
	class="printer-card"
	class:offline={!printer.connected}
	href={resolve('/printers/[id]', { id: printer.id ?? '' })}
	data-printer={printer.id}
>
	<header>
		<div class="title">
			<strong>{printer.name}</strong>
			<small
				>{printer.modelName ?? printer.model}{#if printer.simulated}<span class="sim-badge"
						>Simulator</span
					>{/if}</small
			>
		</div>
		<span
			class="status-pill"
			class:live={active}
			style:--c={active ? 'var(--amber)' : printer.connected ? 'var(--lime)' : 'var(--dim)'}
			><i></i>{label}</span
		>
	</header>
	<div class="body">
		<svg
			class="ring"
			viewBox="0 0 56 56"
			role="img"
			aria-label={percent !== null ? `${percent}% done` : label}
		>
			<circle cx="28" cy="28" r={R} class="track" />
			{#if percent !== null}
				<circle
					cx="28"
					cy="28"
					r={R}
					class="done"
					stroke-dasharray={C}
					stroke-dashoffset={C * (1 - percent / 100)}
				/>
			{/if}
			<text x="28" y="32" text-anchor="middle">{percent !== null ? `${percent}%` : '—'}</text>
		</svg>
		<dl>
			<div>
				<dt>Printing</dt>
				<dd>{active && s?.task ? s.task : '—'}</dd>
			</div>
			<div>
				<dt>Time left</dt>
				<dd>{active ? duration(s?.remainingMinutes) : '—'}</dd>
			</div>
			<div>
				<dt>Nozzle</dt>
				<dd>{temp(s?.nozzle, s?.nozzleTarget)}</dd>
			</div>
			<div>
				<dt>Bed</dt>
				<dd>{temp(s?.bed, s?.bedTarget)}</dd>
			</div>
		</dl>
	</div>
	{#if trays.length}
		<ul class="strip" aria-label="Loaded filament">
			{#each trays as t (t.global)}
				<li
					class="swatch"
					class:none={!t.type}
					class:loaded={t.active}
					style:--swatch={t.color ?? undefined}
					title={t.type ? `${t.type}${t.name ? ` · ${t.name}` : ''}` : 'Empty'}
				>
					<span class="sr-only"
						>{t.type
							? `${t.type}${t.name ? ` ${t.name}` : ''}${t.active ? ', in use' : ''}`
							: 'Empty'}</span
					>
				</li>
			{/each}
		</ul>
	{/if}
	{#if !printer.connected && printer.error}<p class="err">{printer.error}</p>{/if}
	{#if printer.warning}<p class="warn">{printer.warning}</p>{/if}
</a>

<style>
	.printer-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px 16px;
		border-radius: var(--r-lg);
		background: var(--panel);
		border: 1px solid var(--line);
		color: inherit;
		text-decoration: none;
		transition: border-color 0.15s;
	}
	.printer-card:hover {
		border-color: var(--line-strong);
	}
	.printer-card.offline {
		opacity: 0.85;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 10px;
	}
	.title {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.title strong {
		font-size: 15px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title small {
		color: var(--muted);
		font-size: 12px;
	}
	.body {
		display: grid;
		grid-template-columns: 56px 1fr;
		gap: 14px;
		align-items: center;
	}
	.ring {
		width: 56px;
		height: 56px;
	}
	.ring circle {
		fill: none;
		stroke-width: 5;
	}
	.ring .track {
		stroke: rgb(var(--hi) / 0.08);
	}
	.ring .done {
		stroke: var(--amber);
		stroke-linecap: round;
		transform: rotate(-90deg);
		transform-origin: 28px 28px;
	}
	.ring text {
		fill: var(--text-2);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	dl {
		margin: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 12px;
	}
	dl div {
		display: grid;
		min-width: 0;
	}
	dt {
		font-size: 11px;
		color: var(--dim);
	}
	dd {
		margin: 0;
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.strip {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.strip .loaded {
		box-shadow:
			0 0 0 2px var(--panel),
			0 0 0 3px var(--amber);
	}
	.err,
	.warn {
		margin: 0;
		font-size: 12px;
	}
	.err {
		color: var(--err-text);
	}
	.warn {
		color: var(--amber);
	}
</style>
