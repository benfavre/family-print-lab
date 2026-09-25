// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { KidProfile } from '$lib/server/kid/session';
import type { KidLevel } from '$lib/shared/domain';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Set while this browser is in kid mode. */
			kid: KidProfile | null;
		}
		interface PageData {
			/** Set by the root layout while this browser is in kid mode. */
			kid?: { id: string; name: string; level: KidLevel } | null;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
