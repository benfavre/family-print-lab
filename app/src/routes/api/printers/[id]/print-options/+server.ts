import { api } from '$lib/server/http';
import { controlsService } from '$lib/server/modules/controls/service';

/** Print options (auto recovery, sounds, checks) as the printer last reported them. */
export const GET = api(({ params }, rt) => controlsService(rt).options(params.id!));
