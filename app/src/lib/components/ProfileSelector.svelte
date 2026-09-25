<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import Avatar from './Avatar.svelte';
	import ProfileBackground from './ProfileBackground.svelte';

	const { lab, ui } = useApp();
	let opening = $state(false);

	async function choose(id: string, manage = false) {
		if (opening) return;
		opening = true;
		try {
			// Initial entry keeps deep links. Switching makers returns to their project grid.
			if (manage) await goto(resolve('/family'));
			else if (ui.hasEntered && id !== ui.profile) await goto(resolve('/'));
			ui.selectProfile(id);
			await tick();
			document.getElementById('main')?.focus({ preventScroll: true });
		} finally {
			opening = false;
		}
	}

	function focusHeading(node: HTMLElement) {
		node.focus({ preventScroll: true });
	}
</script>

<svelte:head><title>Choose a profile · Family Print Lab</title></svelte:head>

<section class="profile-screen" aria-labelledby="profile-heading">
	<ProfileBackground />
	<div class="profile-brand">
		<span class="brand-mark" aria-hidden="true"
			><span class="cube"><i></i><i></i><i></i></span></span
		>
		<span>Family Print Lab</span>
	</div>
	<div class="profile-content">
		<p class="profile-eyebrow">A little imagination. Something real.</p>
		<h1 id="profile-heading" tabindex="-1" use:focusHeading>Who’s making today?</h1>
		<p class="profile-intro">Choose your space. Pick up where inspiration left off.</p>
		<div class="profile-tiles" role="group" aria-label="Choose a profile">
			{#each lab.ws.profiles as profile (profile.id)}
				<button
					class="profile-tile"
					disabled={opening}
					onclick={() => choose(profile.id)}
					aria-label="Continue as {profile.name}"
				>
					<span class="profile-art"
						><Avatar {profile} /><span class="profile-spark" aria-hidden="true">✦</span></span
					>
					<span class="tile-name">{profile.name}</span>
				</button>
			{/each}
			<button
				class="profile-tile"
				disabled={opening}
				onclick={() => choose('all')}
				aria-label="Continue as Everyone"
			>
				<span class="profile-art everyone-art" aria-hidden="true">
					<svg viewBox="0 0 80 80" fill="none"
						><rect x="12" y="12" width="23" height="23" rx="7" /><rect
							x="45"
							y="12"
							width="23"
							height="23"
							rx="7"
						/><rect x="12" y="45" width="23" height="23" rx="7" /><rect
							x="45"
							y="45"
							width="23"
							height="23"
							rx="7"
						/></svg
					>
				</span>
				<span class="tile-name">Everyone</span>
			</button>
		</div>
		<button class="manage-profiles" disabled={opening} onclick={() => choose('all', true)}
			>{lab.ws.profiles.length ? 'Manage profiles' : 'Create your first profile'}</button
		>
	</div>
	<p class="profile-footnote">One family. Endless things to make.</p>
</section>

<style>
	.profile-screen {
		position: relative;
		isolation: isolate;
		min-height: 100svh;
		display: flex;
		flex-direction: column;
		color: #f4f5fa;
		background: radial-gradient(ellipse at 50% 38%, #17202d 0, #0c1018 45%, #080a0f 85%);
		padding: max(28px, env(safe-area-inset-top)) max(32px, env(safe-area-inset-right))
			max(24px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left));
	}
	.profile-brand {
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 16px;
		font-weight: 650;
		letter-spacing: -0.03em;
	}
	.profile-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 70px 0 90px;
		text-align: center;
	}
	.profile-eyebrow {
		color: #97a8bd;
		font-size: 11px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		margin: 0 0 18px;
	}
	h1 {
		color: #f4f5fa;
		font-size: clamp(32px, 5vw, 58px);
		font-weight: 500;
		letter-spacing: -0.045em;
		line-height: 1.12;
		margin: 0;
		outline: none;
	}
	.profile-intro {
		color: #98a4b7;
		font-size: 15px;
		margin: 18px 0 0;
	}
	.profile-tiles {
		display: flex;
		justify-content: center;
		flex-wrap: wrap;
		gap: 30px;
		max-width: 1000px;
		margin: 48px 0;
	}
	.profile-tile {
		width: 144px;
		background: none;
		border: 0;
		padding: 0;
		color: #9da8b9;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 17px;
	}
	.profile-art {
		display: grid;
		place-items: center;
		position: relative;
		width: 144px;
		height: 144px;
		border-radius: 20px;
		outline: 3px solid transparent;
		outline-offset: 5px;
		transition:
			transform 180ms,
			outline-color 180ms;
	}
	.profile-art :global(.avatar) {
		width: 100%;
		height: 100%;
		border-radius: inherit;
		font-size: 48px;
		font-weight: 550;
		border: 1px solid #ffffff22;
		box-shadow:
			inset 0 1px 0 #ffffff30,
			0 12px 35px #0004;
	}
	.profile-art :global(.avatar.violet) {
		color: #eadfff;
		background: linear-gradient(145deg, #8560c3, #43306e);
	}
	.profile-art :global(.avatar.blue) {
		color: #dcf1ff;
		background: linear-gradient(145deg, #469ccd, #245176);
	}
	.profile-art :global(.avatar.orange) {
		color: #fff0db;
		background: linear-gradient(145deg, #d49b58, #955129);
	}
	.profile-art :global(.avatar.pink) {
		color: #ffe4f3;
		background: linear-gradient(145deg, #c76eaa, #713951);
	}
	.profile-art :global(.avatar.green) {
		color: #dbfff0;
		background: linear-gradient(145deg, #64b29a, #306458);
	}
	.profile-spark {
		position: absolute;
		top: 13px;
		right: 16px;
		font-size: 20px;
		color: #ffffff70;
	}
	.everyone-art {
		background: linear-gradient(145deg, #272f40, #161d2a);
		border: 1px solid #ffffff20;
	}
	.everyone-art svg {
		width: 74px;
		stroke: #aab9d1;
		stroke-width: 2;
	}
	.tile-name {
		font-size: 17px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}
	.profile-tile:hover,
	.profile-tile:focus-visible {
		color: #fff;
		outline: none;
	}
	.profile-tile:hover .profile-art,
	.profile-tile:focus-visible .profile-art {
		transform: translateY(-5px);
		outline-color: #e9f1ff;
	}
	.manage-profiles {
		color: #a4afc0;
		border: 1px solid #535e70;
		background: transparent;
		border-radius: 5px;
		padding: 11px 24px;
		font-size: 13px;
		letter-spacing: 0.06em;
	}
	.manage-profiles:hover,
	.manage-profiles:focus-visible {
		color: #fff;
		border-color: #fff;
	}
	.profile-footnote {
		margin: 0;
		text-align: center;
		color: #7d899e;
		font-size: 12px;
	}
	@media (max-width: 600px) {
		.profile-screen {
			padding-left: 22px;
			padding-right: 22px;
			padding-bottom: 64px;
		}
		.profile-brand {
			font-size: 14px;
		}
		.profile-content {
			padding: 55px 0;
		}
		.profile-eyebrow {
			font-size: 9px;
			letter-spacing: 0.12em;
		}
		.profile-intro {
			max-width: 270px;
			line-height: 1.6;
			font-size: 14px;
		}
		.profile-tiles {
			gap: 28px 26px;
			margin: 36px 0;
		}
		.profile-tile,
		.profile-art {
			width: 112px;
		}
		.profile-art {
			height: 112px;
			border-radius: 15px;
		}
		.profile-art :global(.avatar) {
			font-size: 38px;
		}
		.tile-name {
			font-size: 15px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.profile-art {
			transition: none;
		}
	}
</style>
