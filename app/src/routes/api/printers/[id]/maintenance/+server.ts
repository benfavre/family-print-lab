import { api } from '$lib/server/http';
import { maintenanceOf } from '$lib/server/modules/maintenance/service';

/** A printer's maintenance: tasks with when they are due, the log, print hours, nozzle rack, firmware notes. */
export const GET = api(({ params }, rt) => maintenanceOf(rt).overview(params.id!));
