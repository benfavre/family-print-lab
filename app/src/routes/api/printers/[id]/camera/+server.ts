import { api } from '$lib/server/http';
import { cameraOf } from '$lib/server/modules/camera/http';

/** Whether this printer's camera can be shown now, and if not, why (CameraState). */
export const GET = api(({ params }, rt) => cameraOf(rt).state(params.id!));
