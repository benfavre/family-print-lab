<script lang="ts">
	// Family page → Answer from your phone: what the phone may see and do with the printers (protocol
	// v2), and the household phone key it needs for pictures and commands.
	import { useApp } from '$lib/client/app.svelte';
	import type { CloudStatus } from '$lib/shared/cloud';
	import PhoneKeyDialog from './PhoneKeyDialog.svelte';

	const { lab, ui } = useApp();
	const cloud = $derived(lab.cloud);
	let dialog = $state<null | 'show' | 'forget' | 'control'>(null);

	type Toggle = 'shareProgress' | 'shareAlerts' | 'shareQueue' | 'snapshots';
	const toggles: { key: Toggle; label: string; needsStatus?: boolean }[] = [
		{
			key: 'shareProgress',
			label:
				'Share printer status (what each printer is doing, how far along, time left) so the phone can follow prints and say when they are done'
		},
		{
			key: 'shareAlerts',
			label: 'Share alerts (printer errors in plain words)',
			needsStatus: true
		},
		{ key: 'shareQueue', label: 'Share the print queue (titles and order)', needsStatus: true },
		{
			key: 'snapshots',
			label: 'Camera pictures and live view on the phone, encrypted with the phone key',
			needsStatus: true
		}
	];

	function set(patch: Partial<CloudStatus>) {
		return lab.call('PATCH', '/api/cloud', patch);
	}

	async function control(on: boolean) {
		if (on) dialog = 'control';
		else await set({ remoteControl: false });
	}

	async function forget() {
		if (
			await ui.ask(
				'Forget all phones?',
				'Every phone will need to scan the new phone key before it can see pictures or control the printers again.',
				'Forget all phones'
			)
		)
			dialog = 'forget';
	}
</script>

<div class="remote">
	{#if cloud.protocol === 1}
		<p class="warn">
			Print Lab Cloud has not been updated yet: the phone sees only the first printer’s progress and
			cannot control it.
		</p>
	{/if}
	{#each toggles as t (t.key)}
		<label class="share" class:off={t.needsStatus && !cloud.shareProgress}
			><input
				type="checkbox"
				checked={cloud[t.key]}
				disabled={t.needsStatus && !cloud.shareProgress}
				onchange={async (e) => {
					// A refused change goes back to the saved setting, so it never shows as made.
					const box = e.currentTarget;
					if (!(await set({ [t.key]: box.checked }))) box.checked = cloud[t.key];
				}}
			/>
			{t.label}</label
		>
	{/each}
	<label class="share" class:off={!cloud.shareProgress}
		><input
			type="checkbox"
			checked={cloud.remoteControl}
			disabled={!cloud.shareProgress}
			onchange={(e) => {
				const on = e.currentTarget.checked;
				e.currentTarget.checked = cloud.remoteControl;
				void control(on);
			}}
		/> Allow pause, resume and stop from the phone (parent PIN; Family plan)</label
	>

	<div class="key">
		<p>
			{#if cloud.phoneKey}
				Phone key <code>{cloud.phoneKey.id}</code> · made {new Date(
					cloud.phoneKey.createdAt
				).toLocaleDateString()}
			{:else}
				Pictures and remote control need the phone key on each grown-up’s phone.
			{/if}
		</p>
		<button class="ghost-button" onclick={() => (dialog = 'show')}>Show phone key</button>
		{#if cloud.phoneKey}
			<button class="link-button" onclick={forget}>Forget all phones</button>
		{/if}
	</div>
</div>

{#if dialog}
	<PhoneKeyDialog action={dialog} onclose={() => (dialog = null)} />
{/if}

<style>
	.remote {
		display: grid;
		gap: 8px;
		justify-items: start;
	}
	.share {
		display: flex;
		gap: 8px;
		align-items: center;
		color: var(--text-2);
	}
	.share.off {
		color: var(--muted);
	}
	.warn {
		margin: 0;
		color: var(--amber);
		font-size: 13px;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 4px;
	}
	.key p {
		margin: 0;
		color: var(--muted);
	}
	.key code {
		font-family: var(--mono);
	}
	.link-button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
