<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { useApp } from '$lib/client/app.svelte';
	import {
		ONBOARDING_STEPS,
		ONBOARDING_STEP_LABEL,
		type OnboardingStep
	} from '$lib/shared/onboarding';
	import PrinterStep from '$lib/components/onboarding/PrinterStep.svelte';
	import IntegrationsStep from '$lib/components/onboarding/IntegrationsStep.svelte';
	import FamilyStep from '$lib/components/onboarding/FamilyStep.svelte';
	import DoneStep from '$lib/components/onboarding/DoneStep.svelte';

	// The setup guide: opens by itself on a brand new lab (FirstRunGate) and from Settings →
	// Integrations. The step lives in the address (?step=printer), so Back in the browser works.
	const { lab } = useApp();
	const step = $derived.by((): OnboardingStep => {
		const s = page.url.searchParams.get('step');
		return (ONBOARDING_STEPS as readonly string[]).includes(s ?? '')
			? (s as OnboardingStep)
			: 'welcome';
	});
	const at = $derived(ONBOARDING_STEPS.indexOf(step));
	const HEADINGS: Record<OnboardingStep, string> = {
		welcome: 'Welcome to Family Print Lab',
		printer: 'Connect your printer',
		integrations: 'Choose your tools',
		family: 'Who makes things here?',
		done: 'You are all set'
	};

	function go(to: OnboardingStep) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a query string
		void goto(`${resolve('/welcome')}?step=${to}`, { noScroll: false, keepFocus: false });
	}
	const next = () => go(ONBOARDING_STEPS[Math.min(at + 1, ONBOARDING_STEPS.length - 1)]);
	const back = () => go(ONBOARDING_STEPS[Math.max(at - 1, 0)]);

	async function later() {
		await fetch('/api/onboarding', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'skip' })
		}).catch(() => {});
		await goto(resolve('/'));
	}

	function focusHeading(node: HTMLElement, _step: OnboardingStep) {
		const focus = () => node.focus({ preventScroll: true });
		focus();
		return { update: focus };
	}
</script>

<svelte:head><title>Setup · Family Print Lab</title></svelte:head>

<div class="welcome">
	<ol class="steps" aria-label="Setup steps">
		{#each ONBOARDING_STEPS as s, i (s)}
			<li class:done={i < at} class:current={i === at}>
				<button type="button" onclick={() => go(s)} aria-current={i === at ? 'step' : undefined}
					><span class="n" aria-hidden="true">{i < at ? '✓' : i + 1}</span>{ONBOARDING_STEP_LABEL[
						s
					]}</button
				>
			</li>
		{/each}
	</ol>

	<section class="card" aria-labelledby="welcome-heading">
		<div class="eyebrow">SETUP · STEP {at + 1} OF {ONBOARDING_STEPS.length}</div>
		<h1 id="welcome-heading" tabindex="-1" use:focusHeading={step}>{HEADINGS[step]}</h1>

		{#if step === 'welcome'}
			<div class="intro">
				<p>
					A few minutes to get your family printing: connect the printer, pick the tools you want,
					and add everyone who makes things. You can skip any step and come back from Settings.
				</p>
				<ul>
					<li><b>Local first.</b> Your projects, photos and printer stay on this computer.</li>
					<li>
						<b>Your network only.</b> The app talks to the printer over your home network, not through
						the internet.
					</li>
					<li>
						<b>Nothing leaves without you.</b> AI helpers, notifications and the phone link are off until
						you turn them on.
					</li>
				</ul>
			</div>
		{:else if step === 'printer'}
			<PrinterStep />
		{:else if step === 'integrations'}
			<IntegrationsStep />
		{:else if step === 'family'}
			<FamilyStep />
		{:else}
			<DoneStep ongo={go} />
		{/if}

		<footer class="nav">
			{#if step === 'welcome'}
				<button class="secondary" onclick={later}>Skip, I will set up later</button>
				<button class="primary" onclick={next}>Let’s start</button>
			{:else if step !== 'done'}
				<button class="secondary" onclick={back}>Back</button>
				<span class="grow"></span>
				{#if (step === 'printer' && !(lab.ws.printers ?? []).length) || (step === 'family' && !lab.ws.profiles.length)}
					<button class="secondary" onclick={next}>Skip for now</button>
				{:else}
					<button class="primary" onclick={next}>Next</button>
				{/if}
			{:else}
				<button class="secondary" onclick={back}>Back</button>
			{/if}
		</footer>
	</section>
</div>

<style>
	.welcome {
		max-width: 920px;
		margin: 0 auto;
		padding: 24px 0 40px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.steps button {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		border: 0;
		border-radius: 999px;
		padding: 4px 12px 4px 4px;
		background: rgb(var(--hi) / 0.04);
		box-shadow: 0 0 0 1px var(--line) inset;
		color: var(--muted);
		font-size: 12.5px;
	}
	.n {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		font-size: 11.5px;
		background: rgb(var(--hi) / 0.06);
	}
	.done button {
		color: var(--text-2);
	}
	.done .n {
		color: var(--lime);
	}
	.current button {
		color: var(--text);
		box-shadow: 0 0 0 1px rgb(var(--c1) / 0.5) inset;
		background: rgb(var(--c1) / 0.1);
	}
	.current .n {
		background: var(--cyan);
		color: var(--on-accent);
	}
	.card {
		padding: 22px 24px;
		border-radius: var(--r-lg);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	h1 {
		margin: 6px 0 16px;
		font-size: 26px;
		outline: none;
	}
	.intro p {
		margin: 0 0 12px;
		max-width: 70ch;
		color: var(--text-2);
	}
	.intro ul {
		margin: 0;
		padding-left: 18px;
		display: grid;
		gap: 6px;
		color: var(--muted);
		font-size: 13.5px;
	}
	.intro b {
		color: var(--text);
		font-weight: 550;
	}
	.nav {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
		margin-top: 22px;
		padding-top: 16px;
		border-top: 1px solid var(--line);
	}
	.grow {
		flex: 1;
	}
	@media (max-width: 640px) {
		.card {
			padding: 16px;
		}
		h1 {
			font-size: 22px;
		}
	}
</style>
