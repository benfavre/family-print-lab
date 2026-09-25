<script lang="ts">
	import type { Analysis, Bounds } from '$lib/client/viewer';
	import { printChecks, roughMinutes, type CheckFix } from '$lib/client/printcheck';
	import { duration } from '$lib/client/format';

	let {
		bounds,
		analysis,
		mesh,
		busy,
		blender,
		overhangsOn,
		onfix
	}: {
		bounds: Bounds | null;
		analysis: Analysis | null;
		/** Mesh models can be fixed in place; parametric ones are fixed by editing the design. */
		mesh: boolean;
		busy: boolean;
		blender: boolean;
		overhangsOn: boolean;
		onfix: (fix: CheckFix) => void;
	} = $props();

	const checks = $derived(
		bounds && analysis
			? printChecks({
					size: bounds.size,
					area: analysis.area,
					overhangArea: analysis.overhangArea,
					openEdges: analysis.openEdges,
					contactArea: analysis.contactArea
				})
			: []
	);
	const issues = $derived(checks.filter((c) => c.level !== 'ok').length);
	const failed = $derived(checks.some((c) => c.level === 'fail'));
	const minutes = $derived(analysis && bounds ? roughMinutes(analysis.grams, bounds.size[2]) : 0);
	let open = $state(true);

	const LABEL: Record<CheckFix, string> = {
		fit: 'Scale to fit',
		orient: 'Auto-orient',
		overhangs: 'Show',
		repair: 'Repair'
	};
	/** Which fixes this model can use here and now. */
	const usable = (fix: CheckFix) => fix === 'overhangs' || (mesh && (fix !== 'repair' || blender));
</script>

{#if checks.length}
	<section class="print-check" class:has-fail={failed} aria-label="Ready to print?">
		<button
			type="button"
			class="pc-head"
			aria-expanded={open}
			onclick={() => (open = !open)}
			title={open ? 'Fold' : 'Show the checks'}
		>
			<span class="pc-badge" class:warn={issues && !failed} class:fail={failed}
				>{failed ? '✕' : issues ? '!' : '✓'}</span
			>
			<span class="pc-title"
				>{failed ? 'Not printable yet' : issues ? 'Ready, with notes' : 'Ready to print'}</span
			>
			<span class="pc-count">{issues ? `${issues} to check` : ''}</span>
			<svg class="chev" class:open viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
				><path d="M4 6l4 4 4-4" /></svg
			>
		</button>
		{#if open}
			<ul class="pc-list">
				{#each checks as c (c.id)}
					<li class="lvl-{c.level}">
						<span class="pc-dot" aria-hidden="true"
							>{c.level === 'ok' ? '✓' : c.level === 'fail' ? '✕' : '!'}</span
						>
						<div class="pc-text">
							<b>{c.title}</b>
							<small>{c.detail}</small>
							{#if c.fixes.some(usable)}
								<div class="pc-fixes">
									{#each c.fixes.filter(usable) as fix (fix)}
										<button
											type="button"
											class="mini"
											class:primary-mini={fix !== 'overhangs' && c.level !== 'ok'}
											aria-pressed={fix === 'overhangs' ? overhangsOn : undefined}
											disabled={busy && fix !== 'overhangs'}
											onclick={() => onfix(fix)}
											>{fix === 'overhangs' && overhangsOn ? 'Hide' : LABEL[fix]}</button
										>
									{/each}
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
			{#if analysis}
				<p class="pc-foot">
					≈ <b>{analysis.grams < 10 ? analysis.grams.toFixed(1) : Math.round(analysis.grams)} g</b>
					PLA · about <b>{duration(minutes)}</b>
					<span>rough guess; the slicer knows exactly</span>
				</p>
			{/if}
		{/if}
	</section>
{/if}

<style>
	.print-check {
		margin: 0 0 14px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.02);
	}
	.print-check.has-fail {
		border-color: color-mix(in srgb, var(--red) 45%, transparent);
	}
	.pc-head {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--text);
		text-align: left;
	}
	.pc-badge {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		font-size: 11px;
		font-weight: 700;
		color: var(--on-accent);
		background: var(--lime);
		flex-shrink: 0;
	}
	.pc-badge.warn {
		background: var(--amber);
	}
	.pc-badge.fail {
		background: var(--red);
	}
	.pc-title {
		font-size: 13.5px;
		font-weight: 600;
	}
	.pc-count {
		margin-left: auto;
		font-size: 11.5px;
		color: var(--dim);
	}
	.chev {
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.6;
		stroke-linecap: round;
		transition: transform 0.15s;
	}
	.chev.open {
		transform: rotate(180deg);
	}
	.pc-list {
		list-style: none;
		margin: 0;
		padding: 0 12px 4px;
		display: grid;
		gap: 2px;
	}
	.pc-list li {
		display: flex;
		gap: 9px;
		padding: 7px 0;
		border-top: 1px solid var(--line);
	}
	.pc-dot {
		width: 16px;
		flex-shrink: 0;
		font-size: 12px;
		font-weight: 700;
		text-align: center;
		line-height: 19px;
		color: var(--lime);
	}
	.lvl-warn .pc-dot {
		color: var(--amber);
	}
	.lvl-fail .pc-dot {
		color: var(--red);
	}
	.pc-text {
		min-width: 0;
		display: grid;
		gap: 2px;
	}
	.pc-text b {
		font-size: 12.5px;
		font-weight: 600;
	}
	.lvl-ok .pc-text b {
		font-weight: 500;
		color: var(--muted);
	}
	.pc-text small {
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--dim);
	}
	.pc-fixes {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-top: 4px;
	}
	.pc-fixes .mini {
		padding: 3px 9px;
		font-size: 11.5px;
	}
	.pc-foot {
		margin: 0;
		padding: 9px 12px 11px;
		border-top: 1px solid var(--line);
		font-size: 12px;
		color: var(--muted);
	}
	.pc-foot b {
		color: var(--text);
		font-weight: 600;
	}
	.pc-foot span {
		display: block;
		font-size: 11px;
		color: var(--dim);
	}
</style>
