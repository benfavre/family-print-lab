import { sequence } from '@sveltejs/kit/hooks';
import type { ServerInit } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import { HANDLES } from '$lib/server/hooks';

export const init: ServerInit = () => {
	runtime();
};

// Host and cross-site guards, kid mode, security headers: see lib/server/hooks/index.ts.
export const handle = sequence(...HANDLES);
