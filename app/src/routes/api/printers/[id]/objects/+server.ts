import { api } from '$lib/server/http';
import { controlsService } from '$lib/server/modules/controls/service';

/** The objects on the plate being printed (from the job's sliced file) and which are skipped. */
export const GET = api(({ params }, rt) => controlsService(rt).objects(params.id!));
