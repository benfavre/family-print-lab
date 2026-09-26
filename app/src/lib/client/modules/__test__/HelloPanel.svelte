<script lang="ts">
	import type { PrinterStatus } from '$lib/shared/domain';

	// A printer panel the way a package writes one (test fixture; "__" folders are not loaded by the app).
	let { printer }: { printer: PrinterStatus } = $props();
</script>

<section class="panel">
	<h2 class="panel-title">Hello</h2>
	<p class="panel-empty">{printer.name} says hello.</p>
</section>
