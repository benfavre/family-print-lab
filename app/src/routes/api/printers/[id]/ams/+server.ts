import { api } from '$lib/server/http';
import { amsService } from '$lib/server/modules/ams/service';

/** This printer's tray links and AMS reading options. */
export const GET = api(({ params }, rt) => amsService(rt).state(params.id!));
