// Kid mode sessions. Entering kid mode sets a cookie naming the child's profile; while it is present,
// this browser only reaches the kid pages and the few API routes they need, until a grown-up enters
// the parent PIN. Clearing the browser's site data also leaves kid mode, so this is a guard rail for
// curious kids, not a security boundary.
import type { Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { KidLevel, Profile } from '$lib/shared/domain';
import type { DB } from '../db';
import { profiles } from '../db/schema';

export const KID_COOKIE = 'print_lab_kid';

export type KidProfile = Profile & { kid: KidLevel };

export function kidProfile(db: DB, cookies: Pick<Cookies, 'get'>): KidProfile | null {
	const id = cookies.get(KID_COOKIE);
	if (!id) return null;
	const profile = db.select().from(profiles).where(eq(profiles.id, id)).get() as
		Profile | undefined;
	return profile?.kid ? (profile as KidProfile) : null;
}

export function setKidCookie(cookies: Cookies, profileId: string, secure: boolean) {
	cookies.set(KID_COOKIE, profileId, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure,
		maxAge: 60 * 60 * 24 * 365
	});
}

export function clearKidCookie(cookies: Cookies) {
	cookies.delete(KID_COOKIE, { path: '/' });
}

// Model files: the preview mesh (GET) and the thumbnails the kid page renders after saving (PUT).
const MODEL_FILE = /^\/api\/models\/[^/]+\/versions\/[^/]+\/(model\.stl|thumbnail\.(png|webp))$/;
const KID_READS = new Set(['/api/events', '/api/workspace', '/api/printer']);

/**
 * What a browser in kid mode may do: 'allow', or where to send it. Pages outside /kid go to /kid;
 * API calls outside the kid allow-list are refused. Non-route requests (built assets, fonts) pass.
 */
export function kidAccess(
	method: string,
	pathname: string,
	routeId: string | null
): 'allow' | 'redirect' | 'refuse' {
	if (pathname === '/api/kid' || pathname.startsWith('/api/kid/')) return 'allow';
	if (pathname.startsWith('/api/')) {
		const read = method === 'GET' || method === 'HEAD';
		if (read && (KID_READS.has(pathname) || MODEL_FILE.test(pathname))) return 'allow';
		if (method === 'PUT' && MODEL_FILE.test(pathname) && /\.(png|webp)$/.test(pathname))
			return 'allow';
		return 'refuse';
	}
	if (!routeId) return 'allow';
	return routeId === '/kid' || routeId.startsWith('/kid/') ? 'allow' : 'redirect';
}
