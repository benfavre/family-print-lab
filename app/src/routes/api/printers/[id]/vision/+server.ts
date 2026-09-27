import { api } from '$lib/server/http';
import { visionOf } from '$lib/server/modules/ai-vision/http';

/** A printer's AI checks: on or off, the method, whether one is running, and the latest results. */
export const GET = api(({ params }, rt) => visionOf(rt).overview(params.id!));
