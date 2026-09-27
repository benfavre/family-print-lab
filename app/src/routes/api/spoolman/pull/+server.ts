import { api } from '$lib/server/http';
import { amsService } from '$lib/server/modules/ams/service';

/** Takes the remaining weights of imported spools from Spoolman. */
export const POST = api(async (_event, rt) => await amsService(rt).spoolman.pull());
