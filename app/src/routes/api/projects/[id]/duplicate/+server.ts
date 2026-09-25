import { api } from '$lib/server/http';

export const POST = api(({ params }, rt) => ({ id: rt.lab.duplicateProject(params.id!) }));
