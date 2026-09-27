<script lang="ts">
	import { httpsLink, SITE_NAME, type ProjectSource } from '$lib/shared/model-import';

	let { projectId, revision }: { projectId: string; revision: number } = $props();
	let sources = $state<ProjectSource[]>([]);
	let error = $state('');
	$effect(() => {
		void revision;
		const id = projectId;
		const controller = new AbortController();
		sources = [];
		error = '';
		void fetch(`/api/projects/${encodeURIComponent(id)}/sources`, { signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error('Could not load model credits.');
				const data: { sources: ProjectSource[] } = await res.json();
				if (!controller.signal.aborted) sources = data.sources;
			})
			.catch(() => {
				if (!controller.signal.aborted) error = 'Could not load model credits.';
			});
		return () => controller.abort();
	});
</script>

{#if sources.length}
	<section class="credits" aria-label="Model credits">
		<h3>Model credits</h3>
		<ul>
			{#each sources as source (source.id)}
				{@const modelUrl = httpsLink(source.url)}
				{@const authorUrl = httpsLink(source.authorUrl)}
				{@const licenceUrl = httpsLink(source.licenceUrl)}
				<li>
					<!-- eslint-disable svelte/no-navigation-without-resolve -- validated external source and licence links -->
					<strong
						>{#if modelUrl}<a href={modelUrl} target="_blank" rel="noopener noreferrer"
								>{source.title}</a
							>{:else}{source.title}{/if}</strong
					>
					<p>
						By {#if source.author && authorUrl}<a
								href={authorUrl}
								target="_blank"
								rel="noopener noreferrer">{source.author}</a
							>{:else}{source.author ?? 'an unnamed designer'}{/if} · {SITE_NAME[source.site]}
					</p>
					<p>
						Licence: {#if licenceUrl}<a href={licenceUrl} target="_blank" rel="noopener noreferrer"
								>{source.licence ?? 'Unknown licence'}</a
							>{:else}{source.licence ?? 'Unknown licence'}{/if}
					</p>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				</li>
			{/each}
		</ul>
	</section>
{:else if error}
	<p class="error">{error}</p>
{/if}

<style>
	.credits {
		margin-top: 16px;
	}
	h3 {
		font-size: 0.85rem;
		margin: 0 0 8px;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	li + li {
		margin-top: 12px;
	}
	p {
		margin: 4px 0 0;
		font-size: 0.85rem;
	}
	a {
		overflow-wrap: anywhere;
	}
</style>
