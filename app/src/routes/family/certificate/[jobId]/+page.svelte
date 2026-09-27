<script lang="ts">
	import { resolve } from '$app/paths';
	import { fileUrl } from '$lib/client/models';
	import { galleryImageUrl, type Certificate } from '$lib/shared/kids';

	let { data }: { data: { certificate: Certificate } } = $props();
	const c = $derived(data.certificate);
	// The maker's profile colour as ink (the app's accent tokens change with the theme; paper does not).
	const INK: Record<string, string> = {
		violet: '#6d4fd8',
		blue: '#2f6fd6',
		orange: '#d9761a',
		pink: '#d4407f',
		green: '#23945f'
	};
	const ink = $derived(INK[c.kidColor] ?? INK.violet);
	const picture = $derived(
		c.photoId
			? galleryImageUrl(c.photoId)
			: c.thumbnail
				? fileUrl(c.thumbnail.modelId, c.thumbnail.versionId, 'thumbnail.webp')
				: null
	);
	const date = $derived(
		new Date(c.finishedAt).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'long',
			year: 'numeric'
		})
	);
	const time = $derived(
		c.minutes === null
			? null
			: c.minutes < 60
				? `${Math.max(1, Math.round(c.minutes))} ${Math.round(c.minutes) <= 1 ? 'minute' : 'minutes'}`
				: `${Math.floor(c.minutes / 60)} h ${Math.round(c.minutes % 60)} min`
	);
</script>

<svelte:head><title>Certificate · {c.kidName} · Family Print Lab</title></svelte:head>

<div class="certificate-page">
	<div class="no-print actions">
		<a class="ghost-button" href={resolve('/family/gallery')}>← Gallery</a>
		<button class="primary" onclick={() => window.print()}>Print certificate</button>
	</div>

	<article class="certificate" style:--ink={ink} aria-label="Certificate for {c.kidName}">
		<p class="eyebrow">Family Print Lab</p>
		<h1>Certificate of making</h1>
		<p class="lead">This certifies that</p>
		<p class="name">{c.kidName}</p>
		<p class="lead">designed and printed</p>
		<p class="thing">{c.projectTitle}</p>
		{#if picture}<img class="picture" src={picture} alt="{c.projectTitle}, as printed" />{/if}
		<dl class="facts">
			<div>
				<dt>Finished</dt>
				<dd>{date}</dd>
			</div>
			{#if time}<div>
					<dt>Printing time</dt>
					<dd>{time}</dd>
				</div>{/if}
			{#if c.grams !== null}<div>
					<dt>Filament</dt>
					<dd>{Math.round(c.grams)} g</dd>
				</div>{/if}
		</dl>
		{#if c.badges.length}
			<ul class="badges" aria-label="Badges earned with this print">
				{#each c.badges as b (b.id)}
					<li><span aria-hidden="true">{b.icon}</span> {b.title}</li>
				{/each}
			</ul>
		{/if}
		<div class="sign">
			<span class="line"></span>
			<span>Signed by a proud grown-up</span>
		</div>
	</article>
</div>

<style>
	.certificate-page {
		display: grid;
		gap: 16px;
		justify-items: center;
		padding: 8px 0 24px;
	}
	.actions {
		display: flex;
		gap: 10px;
		width: min(100%, 760px);
		justify-content: space-between;
	}
	.certificate {
		--paper: #fffdf7;
		display: grid;
		justify-items: center;
		gap: 6px;
		width: min(100%, 760px);
		padding: 44px 40px 36px;
		border: 10px double var(--ink);
		border-radius: 18px;
		color: #231d33;
		background: var(--paper);
		text-align: center;
		box-shadow: 0 10px 40px rgb(0 0 0 / 0.25);
	}
	.certificate p {
		margin: 0;
	}
	.eyebrow {
		font: 600 12px var(--mono);
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--ink);
	}
	h1 {
		margin: 4px 0 14px;
		font-size: clamp(28px, 5vw, 42px);
		letter-spacing: -0.02em;
		color: #231d33;
	}
	.lead {
		color: #6b6280;
		font-size: 16px;
	}
	.name {
		font-size: clamp(34px, 7vw, 56px);
		font-weight: 750;
		letter-spacing: -0.02em;
		color: var(--ink);
		line-height: 1.15;
	}
	.thing {
		font-size: 24px;
		font-weight: 650;
		margin-bottom: 10px !important;
	}
	.picture {
		width: min(100%, 320px);
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: 12px;
		border: 1px solid #e8e0d0;
		background: #f4efe4;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 10px 28px;
		margin: 14px 0 4px;
	}
	.facts dt {
		font-size: 12px;
		color: #6b6280;
	}
	.facts dd {
		margin: 2px 0 0;
		font-weight: 650;
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
		margin: 10px 0 0;
		padding: 0;
		list-style: none;
	}
	.badges li {
		padding: 4px 12px;
		border-radius: 999px;
		border: 1px solid var(--ink);
		font-size: 14px;
	}
	.sign {
		display: grid;
		gap: 6px;
		justify-items: center;
		margin-top: 30px;
		color: #6b6280;
		font-size: 13px;
	}
	.line {
		width: 240px;
		border-bottom: 1px solid #231d33;
	}
	@media (max-width: 560px) {
		.certificate {
			padding: 28px 18px;
			border-width: 7px;
		}
	}
	@media print {
		/* Only the certificate goes on paper, on one page. */
		:global(body) {
			height: 100vh;
			overflow: hidden;
		}
		:global(body *) {
			visibility: hidden;
		}
		.certificate,
		.certificate :global(*) {
			visibility: visible;
		}
		.certificate {
			position: absolute;
			inset: 0;
			margin: auto;
			width: 100%;
			height: fit-content;
			padding: 28px 24px;
			box-shadow: none;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}
		.picture {
			width: 240px;
		}
		.no-print {
			display: none;
		}
	}
	@page {
		size: A4 portrait;
		margin: 12mm;
	}
</style>
