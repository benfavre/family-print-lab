import { api } from '$lib/server/http';
import { installed } from '$lib/server/shop';

/** The shop, seen from this computer: the catalogue (if linked), and what was installed here. */
export const GET = api(async (_, rt) => {
	const cloud = rt.cloud?.status();
	if (!rt.cloud || !cloud?.account)
		return { linked: false, configured: !!rt.cloud, catalogue: null, installed: {} };
	return {
		linked: true,
		configured: true,
		catalogue: await rt.cloud.shopCatalogue(),
		installed: installed(rt.db)
	};
});
