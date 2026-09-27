import { api, readJson } from '$lib/server/http';
import { onboardingOf } from '$lib/server/modules/onboarding/route';

/** Whether this is a brand new lab (the setup guide then opens by itself). */
export const GET = api((_event, rt) => onboardingOf(rt).state());

/** Marks the setup guide finished or skipped. */
export const POST = api(async ({ request }, rt) => ({
	state: onboardingOf(rt).mark(await readJson(request, 1_000))
}));
