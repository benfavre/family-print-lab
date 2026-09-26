import { api } from '$lib/server/http';

/** Slices the job's model version for its printer's model in Bambu Studio and attaches the result (a background task). */
export const POST = api(({ params }, rt) => ({ task: rt.printing.sliceJob(params.id!) }));
