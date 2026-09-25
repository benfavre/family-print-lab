<script lang="ts">
	import Modal from './Modal.svelte';

	let { onclose }: { onclose: () => void } = $props();
	const GROUPS: [string, [string, string][]][] = [
		[
			'Everywhere',
			[
				['Ctrl K', 'Search projects, models, views and actions'],
				['/', 'Search the project list'],
				['N', 'New item for this page (idea, print, spool, person)'],
				['G P · G J · G R', 'Go to Projects, Print jobs, Printer'],
				['G F · G M · G I', 'Go to Filament, Family, Integrations'],
				['Right-click · Shift F10', 'Menu for a project, job or model'],
				['?', 'This list']
			]
		],
		[
			'Model workbench',
			[
				['Ctrl S', 'Save as a new version'],
				['Ctrl Z · Ctrl Shift Z', 'Step back / forward through versions'],
				['1 2 3 4', 'Iso, top, front and side view'],
				['F', 'Frame the part'],
				['Esc', 'Stop measuring or picking'],
				['Ctrl Enter', 'Send the AI request']
			]
		],
		[
			'Code editor',
			[
				['Ctrl Space', 'Complete OpenSCAD words'],
				['Ctrl F', 'Find'],
				['Tab', 'Indent the selection']
			]
		]
	];
</script>

<Modal id="shortcuts" {onclose}>
	<header class="dialog-top">
		<h2 id="shortcuts-title">Keyboard shortcuts</h2>
		<button class="icon-button" aria-label="Close" onclick={onclose}>×</button>
	</header>
	{#each GROUPS as [title, keys] (title)}
		<h3>{title}</h3>
		<dl>
			{#each keys as [k, what] (k)}
				<dt>
					{#each k.split(' · ') as alt, i (alt)}{#if i}<span class="or">or</span
							>{/if}{#each alt.split(' ') as part, j (j)}<kbd>{part}</kbd>{/each}{/each}
				</dt>
				<dd>{what}</dd>
			{/each}
		</dl>
	{/each}
</Modal>

<style>
	h3 {
		margin: 14px 0 6px;
		font: 500 11px var(--mono);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--dim);
	}
	dl {
		display: grid;
		grid-template-columns: 210px 1fr;
		gap: 7px 18px;
		margin: 0;
		font-size: 13px;
	}
	dt {
		display: flex;
		gap: 3px;
		align-items: center;
	}
	dd {
		margin: 0;
		color: var(--text-2);
	}
	kbd {
		font-size: 11px;
		color: var(--text-2);
	}
	.or {
		font-size: 11px;
		color: var(--dim);
		margin: 0 4px;
	}
</style>
