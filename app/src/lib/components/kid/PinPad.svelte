<script lang="ts">
	import { onMount } from 'svelte';

	let {
		title,
		text,
		submitLabel = 'Unlock',
		onsubmit,
		onclose
	}: {
		title: string;
		text: string;
		submitLabel?: string;
		/** Returns an error message to show, or nothing when the PIN worked. */
		onsubmit: (pin: string) => Promise<string | void>;
		onclose: () => void;
	} = $props();
	let dialog: HTMLDialogElement;
	let input: HTMLInputElement;
	let pin = $state('');
	let error = $state('');
	let busy = $state(false);

	onMount(() => {
		dialog.showModal();
		input.focus();
	});

	function press(key: string) {
		error = '';
		if (key === 'back') pin = pin.slice(0, -1);
		else if (pin.length < 8) pin += key;
		input.focus();
	}

	async function submit(e?: SubmitEvent) {
		e?.preventDefault();
		if (busy || pin.length < 4) return;
		busy = true;
		const problem = await onsubmit(pin);
		busy = false;
		if (problem) {
			error = problem;
			pin = '';
			input.focus();
		}
	}
</script>

<dialog
	bind:this={dialog}
	class="pin-pad"
	aria-labelledby="pin-title"
	aria-describedby="pin-text"
	{onclose}
>
	<form onsubmit={submit}>
		<h2 id="pin-title">🔒 {title}</h2>
		<p id="pin-text">{text}</p>
		<label class="pin-field">
			<span class="visually-hidden">Parent PIN</span>
			<input
				bind:this={input}
				bind:value={pin}
				oninput={() => {
					pin = pin.replace(/\D/g, '').slice(0, 8);
					error = '';
				}}
				type="password"
				inputmode="numeric"
				autocomplete="off"
				maxlength="8"
				aria-invalid={!!error}
			/>
			<span class="pin-dots" aria-hidden="true"
				>{#each { length: Math.max(4, pin.length) }, i (i)}<i class:on={i < pin.length}
					></i>{/each}</span
			>
		</label>
		<div class="keys">
			{#each ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as k (k)}
				<button type="button" onclick={() => press(k)}>{k}</button>
			{/each}
			<button type="button" aria-label="Delete" onclick={() => press('back')}>⌫</button>
			<button type="button" onclick={() => press('0')}>0</button>
			<button type="submit" class="go" aria-label={submitLabel} disabled={busy || pin.length < 4}
				>✓</button
			>
		</div>
		<p class="pin-error" role="alert">{error}</p>
		<button type="button" class="pin-cancel" onclick={() => dialog.close()}>Cancel</button>
	</form>
</dialog>

<style>
	.pin-pad {
		width: min(360px, calc(100vw - 32px));
		padding: 28px 24px 18px;
		border: 0;
		border-radius: 28px;
		color: #2b2140;
		background: #fffaf3;
		box-shadow: 0 30px 80px rgb(0 0 0 / 0.35);
		color-scheme: light;
		text-align: center;
	}
	.pin-pad::backdrop {
		background: rgb(30 20 50 / 0.55);
		backdrop-filter: blur(4px);
	}
	h2 {
		margin: 0 0 6px;
		font-size: 22px;
	}
	p {
		margin: 0 0 16px;
		color: #6f6485;
		font-size: 15px;
	}
	.pin-field {
		position: relative;
		display: block;
		margin-bottom: 16px;
	}
	.pin-field input {
		position: absolute;
		inset: 0;
		opacity: 0;
		width: 100%;
	}
	.pin-dots {
		display: flex;
		justify-content: center;
		gap: 12px;
		padding: 10px;
		border-radius: 16px;
	}
	.pin-field:focus-within .pin-dots {
		outline: 3px solid #8b6bff;
	}
	.pin-dots i {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid #b9aec9;
	}
	.pin-dots i.on {
		background: #2b2140;
		border-color: #2b2140;
	}
	.keys {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}
	.keys button {
		height: 58px;
		border: 0;
		border-radius: 18px;
		font: 650 24px var(--sans);
		color: #2b2140;
		background: #f3e8da;
		cursor: pointer;
	}
	.keys button:hover {
		background: #ecdcc8;
	}
	.keys button:focus-visible,
	.pin-cancel:focus-visible {
		outline: 3px solid #8b6bff;
		outline-offset: 2px;
	}
	.keys .go {
		color: #fff;
		background: #3cc98a;
	}
	.keys .go:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.pin-error {
		min-height: 22px;
		margin: 12px 0 0;
		color: #c22b52;
		font-weight: 600;
	}
	.pin-cancel {
		margin-top: 4px;
		padding: 10px 18px;
		border: 0;
		background: none;
		color: #6f6485;
		font: 600 15px var(--sans);
		cursor: pointer;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
</style>
