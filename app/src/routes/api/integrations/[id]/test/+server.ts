import { json } from '@sveltejs/kit';
import { api } from '$lib/server/http';
import { testIntegration } from '$lib/server/integrations';
import type { IntegrationId } from '$lib/shared/integrations';

/** Runs a small real round trip through one integration. */
export const POST = api(async ({ params, request }, rt) =>
	json(await testIntegration(rt, params.id as IntegrationId, request.signal))
);
