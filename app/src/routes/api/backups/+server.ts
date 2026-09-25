import { api } from '$lib/server/http';

export const GET = api((_e, rt) => ({ dir: rt.backups.dir, backups: rt.backups.list() }));
export const POST = api(async (_e, rt) => ({ backup: await rt.backups.create('manual') }));
