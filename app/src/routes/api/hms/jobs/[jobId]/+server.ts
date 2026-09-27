import { api } from '$lib/server/http';

/** Printer errors recorded while a job printed (empty when printer error help is off). */
export const GET = api(({ params }, rt) => ({
	events: rt.module('hms')?.forJob(params.jobId!) ?? []
}));
