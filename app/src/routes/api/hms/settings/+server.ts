import { api, readJson } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import type { Runtime } from '$lib/server/runtime';

function hmsOf(rt: Runtime) {
	const hms = rt.module('hms');
	if (!hms) throw new AppError(404, 'Printer error help is off.');
	return hms;
}

export const GET = api((_, rt) => hmsOf(rt).settings());

export const PUT = api(async ({ request }, rt) => {
	const settings = hmsOf(rt).saveSettings(await readJson(request));
	rt.lab.touch('settings');
	return settings;
});
