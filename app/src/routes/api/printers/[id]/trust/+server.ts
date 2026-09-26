import { api } from '$lib/server/http';

/** "Trust the new certificate": forget the pinned one and trust what the printer presents next. */
export const POST = api(({ params }, rt) => ({ printer: rt.printers.trust(params.id!) }));
