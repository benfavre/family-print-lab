<script lang="ts">
	import type { Profile } from '$lib/shared/domain';
	import { initials } from '$lib/client/format';

	let { profile }: { profile: Profile | undefined } = $props();
</script>

{#if profile}<span class="avatar {profile.color}" aria-hidden="true">{initials(profile.name)}</span
	>{/if}
