<script lang="ts">
	import { onMount } from 'svelte';
	import { logOut } from '$lib/client/lan-auth';
	import type { AuthStatus } from '$lib/shared/lan-auth';

	// Only a browser that logged in (another device, or this computer with "Require login here too")
	// gets the button.
	let signedIn = $state(false);
	onMount(async () => {
		try {
			const res = await fetch('/api/auth');
			if (res.ok) signedIn = !!((await res.json()) as AuthStatus).session;
		} catch {
			/* No button when the server cannot say. */
		}
	});
</script>

{#if signedIn}
	<button class="mini logout" title="Log out of this device" onclick={logOut}>Log out</button>
{/if}

<style>
	.logout {
		white-space: nowrap;
	}
</style>
