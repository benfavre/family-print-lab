// The module's service for its routes (503 when the module is off).
import type { Runtime } from '$lib/server/runtime';
import { AppError } from '$lib/server/validation';

export function onboardingOf(rt: Runtime) {
	const m = rt.module('onboarding');
	if (!m) throw new AppError(503, 'The setup guide is switched off.');
	return m;
}
