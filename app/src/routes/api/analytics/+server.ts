import { api } from '$lib/server/http';
import { AppError } from '$lib/server/validation';
import { readFilter } from '$lib/server/modules/analytics/validation';

/** The statistics dashboard's numbers for ?from&to&printer&person&tz. */
export const GET = api(({ url }, rt) => {
	const analytics = rt.module('analytics');
	if (!analytics) throw new AppError(503, 'Statistics are not available right now.');
	return analytics.summary(readFilter(url.searchParams));
});
