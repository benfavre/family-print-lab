<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import type { VisionMethod, VisionSettings, VisionSettingsView } from '$lib/shared/vision';

	// Integrations → AI print checks: on or off, how pictures are checked, how often, how sure before an
	// alert, and whether to pause the print. Off, and nothing leaves the computer, until a parent says so.
	const { lab } = useApp();
	let view = $state<VisionSettingsView | null>(null);
	let error = $state('');
	const s = $derived(view?.settings ?? null);

	onMount(async () => {
		try {
			const res = await fetch('/api/vision/settings');
			const data = await res.json().catch(() => ({}));
			if (!res.ok) error = data.error ?? `Could not load the AI check settings (${res.status}).`;
			else view = data;
		} catch {
			error = 'Could not reach the app server. Is it still running?';
		}
	});

	async function save(patch: Partial<VisionSettings>, done = 'AI check settings saved.') {
		const res = await lab.call<VisionSettingsView>('PUT', '/api/vision/settings', patch, done);
		if (res?.settings) view = res;
	}

	/** An empty box turns that schedule off. */
	function every(
		e: Event & { currentTarget: HTMLInputElement },
		key: 'everyLayers' | 'everyMinutes'
	) {
		const v = e.currentTarget.valueAsNumber;
		void save({ [key]: Number.isFinite(v) && v >= 1 ? Math.round(v) : null });
	}
</script>

<section class="int-section" id="ai-vision" aria-labelledby="ai-vision-title">
	<h2 id="ai-vision-title">AI print checks</h2>
	<p class="section-lead">
		Looks at the printer’s camera while it prints to catch spaghetti, a part that came loose or a
		blob early. Off until you switch it on.
	</p>
	{#if error}
		<p class="error">{error}</p>
	{:else if !view || !s}
		<p class="section-lead">Loading…</p>
	{:else}
		<label class="option"
			><input
				type="checkbox"
				checked={s.enabled}
				onchange={(e) =>
					save(
						{ enabled: e.currentTarget.checked },
						e.currentTarget.checked ? 'AI checks are on.' : 'AI checks are off.'
					)}
			/> Check prints automatically</label
		>
		<div class="grid">
			<label class="field"
				>How to check
				<select
					value={s.method}
					onchange={(e) => save({ method: e.currentTarget.value as VisionMethod })}
				>
					{#each view.methods as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
				</select>
			</label>
			<label class="field"
				>Every how many layers
				<input
					type="number"
					min="1"
					max="1000"
					step="1"
					inputmode="numeric"
					placeholder="Not by layers"
					value={s.everyLayers ?? ''}
					onchange={(e) => every(e, 'everyLayers')}
				/>
			</label>
			<label class="field"
				>Every how many minutes
				<input
					type="number"
					min="1"
					max="240"
					step="1"
					inputmode="numeric"
					placeholder="Not by time"
					value={s.everyMinutes ?? ''}
					onchange={(e) => every(e, 'everyMinutes')}
				/>
			</label>
			<label class="field"
				>Alert when at least {Math.round(s.threshold * 100)}% sure
				<input
					type="range"
					min="50"
					max="99"
					step="1"
					value={Math.round(s.threshold * 100)}
					onchange={(e) => save({ threshold: e.currentTarget.valueAsNumber / 100 })}
				/>
			</label>
		</div>
		<p class="note">
			{#if s.method === 'local'}
				The rough check runs on this computer and sends nothing anywhere. It only notices sudden
				changes in the picture, so it misses some problems and sometimes raises a false alarm.
			{:else}
				Each check sends one camera picture and the print’s name to the AI you picked. Prints are
				checked with your account there, so they count towards its limits.
			{/if}
		</p>
		{#if s.method === 'local' && !view.ffmpeg}
			<p class="warn">The rough check needs ffmpeg on this computer (sudo apt install ffmpeg).</p>
		{/if}
		{#if !view.camera}
			<p class="warn">Camera support is not running, so there are no pictures to check.</p>
		{/if}
		<label class="option"
			><input
				type="checkbox"
				checked={s.autoPause}
				onchange={(e) => save({ autoPause: e.currentTarget.checked })}
			/> Pause the print when sure</label
		>
		<p class="note">
			Alerts go to the bell and your notification channels. Each printer can be switched off on its
			own page.
		</p>
	{/if}
</section>

<style>
	.int-section {
		margin-bottom: 26px;
		scroll-margin-top: 80px;
	}
	h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		margin-bottom: 10px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 0 12px;
		max-width: 900px;
	}
	.note {
		margin: 0 0 10px;
		font-size: 12.5px;
		color: var(--dim);
		max-width: 90ch;
	}
	.warn {
		margin: 0 0 10px;
		font-size: 13px;
		color: var(--amber);
	}
</style>
