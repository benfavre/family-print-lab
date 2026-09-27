import { api } from '$lib/server/http';
import { amsService } from '$lib/server/modules/ams/service';

/** Asks Spoolman for its version. */
export const POST = api(async (_event, rt) => ({ detail: await amsService(rt).spoolman.test() }));
