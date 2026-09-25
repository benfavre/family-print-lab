<script lang="ts">
	import type { ModelVersion } from '$lib/shared/cad';
	import { fileUrl } from '$lib/client/models';
	import { stamp } from '$lib/client/format';
	import { download } from '$lib/client/actions';

	let {
		modelId,
		versions,
		currentId,
		viewingId,
		comparingId,
		oncompare,
		busy,
		onview,
		onrestore
	}: {
		modelId: string;
		versions: ModelVersion[];
		currentId: string | null;
		viewingId: string | null;
		comparingId: string | null;
		oncompare: (v: ModelVersion | null) => void;
		busy: boolean;
		onview: (v: ModelVersion | null) => void;
		onrestore: (v: ModelVersion) => void;
	} = $props();

	const ORIGIN: Record<string, string> = {
		editor: '✎',
		ai: '✦',
		upload: '⇪',
		'mesh-op': '◇',
		blender: '◉',
		copy: '⧉'
	};
	const ORIGIN_LABEL: Record<string, string> = {
		editor: 'Edited',
		ai: 'AI',
		upload: 'Imported',
		'mesh-op': 'Mesh tool',
		blender: 'Blender',
		copy: 'Copied'
	};
	const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
</script>

<ol class="versions">
	{#each versions as v (v.id)}
		{@const current = v.id === currentId}
		<li class:current class:viewing={v.id === viewingId}>
			<button
				type="button"
				class="v-main"
				onclick={() => onview(v.id === viewingId || current ? null : v)}
				aria-pressed={v.id === viewingId}
				title={current ? 'Current version' : 'Preview this version'}
			>
				<span class="thumb">
					{#if v.hasThumbnail}<img
							src={fileUrl(modelId, v.id, 'thumbnail.png')}
							alt=""
							loading="lazy"
						/>{:else}<span class="num">v{v.number}</span>{/if}
				</span>
				<span class="info">
					<span class="line1"
						><b>v{v.number}</b>{#if current}<span class="cur">current</span>{/if}<span
							class="origin"
							title={ORIGIN_LABEL[v.origin] ?? v.origin}>{ORIGIN[v.origin] ?? '·'}</span
						></span
					>
					<span class="note">{v.note || '—'}</span>
					<span class="sub"
						>{fmt(v.sizeX)}×{fmt(v.sizeY)}×{fmt(v.sizeZ)} mm · {stamp(v.createdAt)}</span
					>
				</span>
			</button>
			<span class="v-actions">
				{#if !current}<button
						type="button"
						class="mini icon"
						class:on={v.id === comparingId}
						aria-pressed={v.id === comparingId}
						title="Overlay on the current version"
						aria-label="Compare v{v.number} with the current version"
						onclick={() => oncompare(v.id === comparingId ? null : v)}>⧉</button
					>{/if}
				{#if !current}<button
						type="button"
						class="mini"
						disabled={busy}
						onclick={() => onrestore(v)}>Restore</button
					>{/if}
				<button
					type="button"
					class="mini icon"
					title="Download STL"
					aria-label="Download v{v.number} as STL"
					onclick={() => download(`${fileUrl(modelId, v.id, 'model.stl')}?download`)}>⤓</button
				>
			</span>
		</li>
	{/each}
</ol>

<style>
	.versions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	li {
		position: relative;
		display: flex;
		align-items: center;
		gap: 4px;
		border-radius: var(--r-md);
		padding: 3px;
		border: 1px solid transparent;
	}
	li:hover {
		background: rgb(var(--hi) / 0.03);
	}
	li.current {
		border-color: rgb(var(--c1) / 0.3);
	}
	li.viewing {
		border-color: rgb(var(--c4) / 0.55);
		background: rgb(var(--c4) / 0.06);
	}
	.v-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		border: 0;
		background: transparent;
		text-align: left;
		padding: 2px;
		color: inherit;
	}
	.thumb {
		width: 52px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 6px;
		background: rgb(var(--hi) / 0.04);
		border: 1px solid var(--line);
		display: grid;
		place-items: center;
		overflow: hidden;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.num {
		font: 500 11px var(--mono);
		color: var(--dim);
	}
	.info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 1px;
	}
	.line1 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}
	.cur {
		font-size: 10.5px;
		color: var(--cyan);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.origin {
		color: var(--dim);
		font-size: 11px;
	}
	.note {
		font-size: 12px;
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sub {
		font-size: 11px;
		color: var(--dim);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Row buttons float over the right edge on hover/focus, so notes and sizes keep the full width. */
	.v-actions {
		position: absolute;
		right: 6px;
		bottom: 6px;
		display: flex;
		gap: 2px;
		align-items: center;
		padding: 2px;
		border-radius: var(--r-sm);
		background: var(--panel);
		box-shadow: 0 0 0 1px var(--line);
		opacity: 0;
		transition: opacity 0.15s;
	}
	.v-actions .on {
		color: var(--amber);
		background: rgb(var(--c4) / 0.12);
	}
	li:has(.on) .v-actions,
	li:hover .v-actions,
	li:focus-within .v-actions {
		opacity: 1;
	}
	/* Touch: the buttons get their own line under the note instead of squeezing it. */
	@media (hover: none) {
		li {
			flex-wrap: wrap;
		}
		.v-actions {
			position: static;
			opacity: 1;
			background: none;
			box-shadow: none;
			width: 100%;
			justify-content: flex-end;
			padding: 0 2px 2px;
		}
		li:not(:has(.v-actions > :nth-child(2))) .v-actions {
			position: absolute;
			width: auto;
			right: 4px;
			bottom: 4px;
		}
		li:not(:has(.v-actions > :nth-child(2))) .info {
			padding-right: 26px;
		}
	}
</style>
