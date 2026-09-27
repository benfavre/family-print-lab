<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { kidsFeed } from '$lib/client/modules/kids/feed.svelte';
	import { BADGES, badgeInfo, galleryImageUrl, type KidSelf } from '$lib/shared/kids';

	// Kid mode: a celebration for new badges and a gentle "not today" once the limits are reached
	// ('party', at the top of the page), or the child's badges and their own photos ('shelf').
	let {
		kidId,
		show,
		little = false
	}: { kidId: string; show: 'party' | 'shelf'; little?: boolean } = $props();
	const { lab } = useApp();
	const feed = kidsFeed<KidSelf>(lab, () => '/api/kids/me');
	const earned = $derived(new Map((feed.data?.badges ?? []).map((b) => [b.badge, b])));

	// Which badges this browser already celebrated (a per-device nicety; nothing depends on it).
	const seenKey = $derived(`print-lab-kid-badges-seen:${kidId}`);
	let seen = $state<string | null>(null);
	$effect(() => {
		try {
			seen = localStorage.getItem(seenKey) ?? '';
		} catch {
			seen = '';
		}
	});
	const fresh = $derived(
		seen === null
			? []
			: (feed.data?.badges ?? []).filter((b) => b.earnedAt > seen!).map((b) => badgeInfo(b.badge)!)
	);

	function celebrated() {
		const newest = (feed.data?.badges ?? []).reduce(
			(m, b) => (b.earnedAt > m ? b.earnedAt : m),
			''
		);
		seen = newest;
		try {
			localStorage.setItem(seenKey, newest);
		} catch {
			// Private windows: it simply celebrates again next time.
		}
	}
</script>

{#if show === 'party' && fresh.length}
	<section class="party" role="status" aria-live="polite">
		<div class="confetti" aria-hidden="true">
			{#each Array.from({ length: 18 }, (_, i) => i) as i (i)}<i style:--i={i}></i>{/each}
		</div>
		<span class="party-icon" aria-hidden="true">{fresh[0].icon}</span>
		<div>
			<strong
				>{fresh.length === 1
					? 'You got a new badge!'
					: `You got ${fresh.length} new badges!`}</strong
			>
			<p>{fresh.map((b) => b.title).join(', ')}</p>
		</div>
		<button class="kid-button berry" onclick={celebrated}>Yay! 🎉</button>
	</section>
{/if}

{#if show === 'party' && feed.data?.blocked}
	<p class="not-today" role="status">{feed.data.blocked}</p>
{/if}

{#if show === 'shelf' && feed.data}
	<h2 class="kid-heading">My badges</h2>
	<ul class="badges">
		{#each BADGES as b (b.id)}
			{@const got = earned.has(b.id)}
			<li class="badge" class:got>
				<span class="badge-icon" aria-hidden="true">{got ? b.icon : '❔'}</span>
				<strong>{b.title}</strong>
				{#if !little}<span class="badge-text"
						>{got ? b.text : `Not yet: ${b.text.toLowerCase()}`}</span
					>{/if}
				<span class="sr-only">{got ? 'Earned' : 'Not earned yet'}</span>
			</li>
		{/each}
	</ul>

	{#if feed.data.gallery.length}
		<h2 class="kid-heading">My photos</h2>
		<ul class="photos">
			{#each feed.data.gallery as g (g.id)}
				<li>
					<img src={galleryImageUrl(g.id)} alt={g.caption || 'Something I made'} loading="lazy" />
					<span>{g.caption || g.projectTitle || 'Something I made'}</span>
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<style>
	.party {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
		padding: 20px 22px;
		margin: 0 0 18px;
		border-radius: 26px;
		background: #fff1c9;
		box-shadow: 0 5px 0 #f6dc93;
		overflow: hidden;
	}
	.party > div:not(.confetti) {
		flex: 1;
		min-width: 180px;
	}
	.party strong {
		font-size: 22px;
		letter-spacing: -0.02em;
	}
	.party p {
		margin: 4px 0 0;
	}
	.party-icon {
		font-size: 54px;
		animation: pop 0.6s ease-out;
	}
	.confetti {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	.confetti i {
		position: absolute;
		top: -12px;
		left: calc(var(--i) * 5.5%);
		width: 8px;
		height: 12px;
		border-radius: 2px;
		background: hsl(calc(var(--i) * 47) 90% 60%);
		animation: fall 2.4s ease-in calc(var(--i) * 0.08s) 2 both;
	}
	@keyframes fall {
		to {
			transform: translateY(160px) rotate(540deg);
			opacity: 0;
		}
	}
	@keyframes pop {
		from {
			transform: scale(0.3) rotate(-20deg);
		}
		70% {
			transform: scale(1.2);
		}
	}
	.not-today {
		margin: 0 0 18px;
		padding: 14px 18px;
		border-radius: 22px;
		background: #eef0ff;
		font-weight: 650;
	}
	.badges {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 12px;
		margin: 0 0 8px;
		padding: 0;
		list-style: none;
	}
	.badge {
		display: grid;
		justify-items: center;
		gap: 4px;
		padding: 14px 10px;
		border-radius: 22px;
		background: rgb(255 255 255 / 0.55);
		color: var(--k-muted);
		text-align: center;
	}
	.badge.got {
		color: var(--k-ink);
		background: var(--k-card);
		box-shadow: 0 5px 0 var(--k-line);
	}
	.badge-icon {
		font-size: 40px;
		line-height: 1.1;
	}
	.badge:not(.got) .badge-icon {
		opacity: 0.45;
	}
	.badge-text {
		font-size: 14px;
		color: var(--k-muted);
	}
	.photos {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.photos li {
		display: grid;
		gap: 8px;
		padding: 10px 10px 14px;
		border-radius: 22px;
		background: var(--k-card);
		box-shadow: 0 5px 0 var(--k-line);
		font-weight: 650;
	}
	.photos img {
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: 14px;
		background: #fdf1e2;
	}
	@media (prefers-reduced-motion: reduce) {
		.confetti {
			display: none;
		}
		.party-icon {
			animation: none;
		}
	}
</style>
