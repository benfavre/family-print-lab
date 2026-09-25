<script lang="ts">
	import { onMount } from 'svelte';
	import type { createProfileScene } from '$lib/client/profile-scene';

	let host: HTMLDivElement;
	let scene: ReturnType<typeof createProfileScene> | undefined;
	let ready = $state(false);
	let paused = $state(false);
	let reduced = $state(false);

	onMount(() => {
		let disposed = false;
		const preference = matchMedia('(prefers-reduced-motion: reduce)');
		const followMotion = () => (reduced = preference.matches);
		followMotion();
		preference.addEventListener('change', followMotion);
		// Keep the profile buttons interactive while the decorative scene loads.
		void import('$lib/client/profile-scene')
			.then(({ createProfileScene }) => {
				if (disposed) return;
				scene = createProfileScene(host);
				ready = true;
			})
			.catch(() => {
				// Keep the CSS backdrop if WebGL or the optional scene chunk is unavailable.
			});
		return () => {
			disposed = true;
			preference.removeEventListener('change', followMotion);
			scene?.dispose();
		};
	});
</script>

<div class="background" aria-hidden="true">
	<div class="ambient ambient-cyan"></div>
	<div class="ambient ambient-violet"></div>
	<div class="blueprint"></div>
	<div class="scene" bind:this={host}></div>
	<div class="veil"></div>
</div>
{#if ready && !reduced}
	<button
		class="motion-toggle"
		aria-label={paused ? 'Resume background animation' : 'Pause background animation'}
		aria-pressed={paused}
		onclick={() => {
			paused = !paused;
			scene?.setPaused(paused);
		}}
	>
		<span aria-hidden="true">{paused ? '▷' : 'Ⅱ'}</span>{paused ? 'Resume motion' : 'Pause motion'}
	</button>
{/if}

<style>
	.background {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: -1;
	}
	.ambient {
		position: absolute;
		width: 60%;
		height: 75%;
		filter: blur(75px);
		opacity: 0.16;
		border-radius: 50%;
	}
	.ambient-cyan {
		left: -35%;
		top: -12%;
		background: #238a9b;
	}
	.ambient-violet {
		right: -32%;
		bottom: -5%;
		background: #7754ba;
	}
	.scene {
		position: absolute;
		inset: 0;
		opacity: 0.78;
	}
	.scene :global(canvas) {
		display: block;
		width: 100%;
		height: 100%;
	}
	.blueprint {
		position: absolute;
		inset: 40% -50% -65%;
		background-image:
			linear-gradient(#667da313 1px, transparent 1px),
			linear-gradient(90deg, #667da313 1px, transparent 1px);
		background-size: 64px 64px;
		transform: perspective(550px) rotateX(60deg);
		mask-image: radial-gradient(ellipse, #000, transparent 68%);
	}
	.veil {
		position: absolute;
		inset: 0;
		background:
			radial-gradient(ellipse at 50% 43%, #0c111bc9 0%, #0c111b87 30%, #090d1620 65%),
			linear-gradient(0deg, #080a0fe6, transparent 22%, transparent 85%, #080a0f40);
	}
	.motion-toggle {
		position: absolute;
		right: 32px;
		bottom: 20px;
		display: flex;
		align-items: center;
		gap: 7px;
		color: #9ba9be;
		border: 1px solid #a0b6d425;
		background: #101722aa;
		border-radius: 20px;
		padding: 7px 12px;
		font-size: 11px;
	}
	.motion-toggle:hover {
		color: #fff;
		border-color: #a0b6d470;
	}
	@media (max-width: 600px) {
		.scene {
			opacity: 0.5;
		}
		.veil {
			background: linear-gradient(90deg, #080a0f20, #0c111b99 25%, #0c111b99 75%, #080a0f20);
		}
		.motion-toggle {
			right: 50%;
			transform: translateX(50%);
			bottom: 15px;
			white-space: nowrap;
		}
	}
</style>
