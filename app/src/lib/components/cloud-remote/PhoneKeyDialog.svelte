<script lang="ts">
	// Asks for the parent PIN, then shows the household phone key as a QR code (or turns remote
	// control on). The key sits in the link's fragment, which the phone's browser never sends to a
	// server, so Print Lab Cloud never sees it.
	import { useApp } from '$lib/client/app.svelte';
	import { qrMatrix, qrPath } from '$lib/shared/qr';
	import Modal from '../Modal.svelte';

	const { action, onclose }: { action: 'show' | 'forget' | 'control'; onclose: () => void } =
		$props();
	const { lab, ui } = useApp();

	let pin = $state('');
	let busy = $state(false);
	let shown = $state<{ id: string; url: string } | null>(null);
	// A very long cloud address does not fit the QR sizes drawn here: then only the link is offered.
	const qr = $derived.by(() => {
		if (!shown) return null;
		try {
			return qrPath(qrMatrix(shown.url));
		} catch {
			return null;
		}
	});

	const title = $derived(
		{
			show: 'Phone key',
			forget: 'Forget all phones',
			control: 'Remote control'
		}[action]
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			if (action === 'control') {
				const ok = await lab.call(
					'PATCH',
					'/api/cloud',
					{ remoteControl: true, pin },
					'Pause, resume and stop from the phone are on.'
				);
				if (ok) onclose();
				return;
			}
			const r = await lab.call<{ id: string; url: string }>(
				'POST',
				'/api/cloud/phone-key',
				{ action, pin },
				action === 'forget' ? 'New phone key made. Phones must scan it again.' : undefined
			);
			if (r) shown = { id: r.id, url: r.url };
		} finally {
			busy = false;
			pin = '';
		}
	}

	async function copy() {
		if (!shown) return;
		await navigator.clipboard?.writeText(shown.url).catch(() => {});
		ui.toast('Link copied. Send it only to your own phone.');
	}
</script>

<Modal id="phone-key" {onclose} {busy}>
	<div class="dialog-top">
		<div>
			<div class="eyebrow">PRINT LAB CLOUD</div>
			<h2 id="phone-key-title">{title}</h2>
		</div>
	</div>
	{#if shown}
		<div class="shown">
			{#if qr}
				<svg
					class="qr"
					viewBox="0 0 {qr.size} {qr.size}"
					role="img"
					aria-label="QR code with the phone key"
					shape-rendering="crispEdges"
					><rect width={qr.size} height={qr.size} fill="#fff" /><path d={qr.d} fill="#000" /></svg
				>
			{:else}
				<p class="hint">This cloud address is too long for a QR code. Copy the link instead.</p>
			{/if}
			<div class="how">
				<p>
					Scan this with the camera of each grown-up’s phone and open the link. Print Lab keeps the
					key on the phone; Print Lab Cloud never sees it. Scan a key from each linked computer;
					adding this key keeps the others.
				</p>
				<p class="hint">
					With it, a phone signed in to your account can see camera pictures and, if you allow it,
					pause, resume or stop prints. Show it only to your family. Key <code>{shown.id}</code>.
				</p>
				<button type="button" class="link-button" onclick={copy}>Copy the link instead</button>
			</div>
		</div>
		<div class="dialog-actions">
			<span></span>
			<button type="button" class="primary" onclick={onclose}>Done</button>
		</div>
	{:else}
		<form onsubmit={submit}>
			<p class="hint">
				{action === 'control'
					? 'A phone with the phone key will be able to pause, resume and stop prints. Nothing else: no temperatures, no G-code.'
					: action === 'forget'
						? 'Phones with the old key will stop working until they scan the new one.'
						: 'Only a parent should show the phone key.'}
			</p>
			<label class="field"
				>Parent PIN<input
					type="password"
					inputmode="numeric"
					autocomplete="off"
					maxlength="8"
					required
					bind:value={pin}
				/></label
			>
			<div class="dialog-actions">
				<span></span>
				<div>
					<button type="button" class="secondary" onclick={onclose}>Cancel</button>
					<button class="primary" disabled={busy || !pin}
						>{action === 'control'
							? 'Turn on'
							: action === 'forget'
								? 'Make a new key'
								: 'Show key'}</button
					>
				</div>
			</div>
		</form>
	{/if}
</Modal>

<style>
	form {
		display: grid;
		gap: 12px;
	}
	.hint {
		margin: 0;
		max-width: 60ch;
		color: var(--muted);
	}
	.shown {
		display: flex;
		flex-wrap: wrap;
		gap: 18px;
		align-items: flex-start;
	}
	.qr {
		width: 220px;
		max-width: 100%;
		height: auto;
		border-radius: 8px;
	}
	.how {
		display: grid;
		gap: 10px;
		flex: 1 1 240px;
	}
	.how p {
		margin: 0;
	}
	code {
		font-family: var(--mono);
	}
	.link-button {
		justify-self: start;
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
