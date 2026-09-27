import { api } from '$lib/server/http';
import { amsService } from '$lib/server/modules/ams/service';

/** Adds Spoolman's spools to the shelf (ones already imported are skipped). */
export const POST = api(async (_event, rt) => await amsService(rt).spoolman.import());
