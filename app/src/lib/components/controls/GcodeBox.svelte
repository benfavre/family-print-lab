<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { controlTarget, runCommand } from '$lib/client/modules/controls/commands';
	import { gcodeLines, gcodeReason } from '$lib/shared/controls';
	import type { PrinterStatus } from '$lib/shared/domain';

	// Raw G-code for grown-ups who know what it does: hidden until they say so, refused for commands
	// that would wreck a running print, and confirmed before sending.
	let { printer, offline }: { printer: PrinterStatus; offline: string | null } = $props();
	const app = useApp();
	const t = $derived(controlTarget(printer));
	let understood = $state(false);
	let text = $state('');
	let busy = $state(false);
	const lines = $derived(gcodeLines(text));
	const reason = $derived(
		offline ??
			(lines.length > 50 ? 'Send at most 50 lines at a time.' : null) ??
			(lines.some((l) => l.length > 256) ? 'Lines can be up to 256 characters.' : null) ??
			gcodeReason(t, lines)
	);

	async function send() {
		if (
			!(await app.ui.ask(
				`Send ${lines.length} G-code ${lines.length === 1 ? 'line' : 'lines'}?`,
				'The printer runs them straight away. A wrong command can crash the print head or damage the printer.',
				'Send G-code'
			))
		)
			return;
		busy = true;
		try {
			if (await runCommand(app, printer, 'print.gcode_line:custom', { lines }, 'G-code sent.'))
				text = '';
		} finally {
			busy = false;
		}
	}
</script>

<details class="group gcode">
	<summary>Custom G-code</summary>
	<label class="check"
		><input type="checkbox" bind:checked={understood} /> I know what I am doing</label
	>
	{#if understood}
		<textarea
			bind:value={text}
			rows="4"
			spellcheck="false"
			placeholder="One command per line, e.g. M106 P1 S255"
			aria-label="G-code lines"></textarea>
		<div class="row">
			<button class="mini" disabled={!!reason || busy} onclick={send}>Send</button>
			{#if reason && text.trim()}<small class="why">{reason}</small>{/if}
		</div>
	{/if}
</details>

<style>
	.group {
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}
	summary {
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		margin: 8px 0;
	}
	textarea {
		display: block;
		width: 100%;
		box-sizing: border-box;
		font-family: var(--mono, ui-monospace, monospace);
		font-size: 13px;
		padding: 8px;
		border-radius: var(--r-sm);
		border: 1px solid var(--line);
		background: transparent;
		margin-bottom: 6px;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.why {
		color: var(--muted);
		font-size: 12px;
	}
</style>
