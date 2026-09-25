<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<div class="layout">
	<div class="main-col">
		<section class="hero">
			<div class="hero-copy">
				<a class="crumb" href={resolve('/')}><span aria-hidden="true">←</span> All projects</a>
				<div class="eyebrow">ERROR {page.status}</div>
				<h1>{page.status === 404 ? 'Nothing here' : 'Something went wrong'}</h1>
				<p>{page.error?.message}</p>
			</div>
		</section>
	</div>
</div>
