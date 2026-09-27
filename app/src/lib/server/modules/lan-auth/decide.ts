// Who needs to log in (pure, so the whole decision table is tested on its own).
//
// A request is local when it comes from this computer (a loopback address) and names it (Host
// localhost, 127.0.0.1 or [::1]); anything else reached the app over the network, including a proxy on
// this computer forwarding for a LAN host name. Local requests stay open unless "Require login here
// too" is on. Other devices always need a session: until a household password exists they get "Set a
// password on the computer first". So exposing the app (HOST, ALLOWED_HOSTS) turns login on by itself.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackAddress(ip: string): boolean {
	const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
	return v4 === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export const isLocalHostname = (hostname: string) => LOCAL_HOSTS.has(hostname.toLowerCase());

export function isLocalRequest(ip: string, hostname: string): boolean {
	return isLoopbackAddress(ip) && isLocalHostname(hostname);
}

/** Why other devices can reach the app, from the server settings (for the settings page), or null. */
export function exposedBy(env: Record<string, string | undefined>): string | null {
	const host = env.HOST?.trim();
	if (host && !isLocalHostname(host)) return `HOST=${host}`;
	const hosts = (env.ALLOWED_HOSTS ?? '')
		.split(',')
		.map((h) => h.trim())
		.filter((h) => h && !isLocalHostname(h));
	return hosts.length ? `ALLOWED_HOSTS=${hosts.join(',')}` : null;
}

/** Paths that work without a session: the login page and the login call. */
export function isPublicPath(pathname: string): boolean {
	return pathname === '/login' || pathname === '/api/auth/login';
}

export type AuthDecision =
	/** Go on. */
	| 'allow'
	/** Log in first (pages: go to /login; API: 401). */
	| 'login'
	/** No household password yet: other devices are told to set one on the computer. */
	| 'setup'
	/** The login module is off (it failed to start): other devices are refused. */
	| 'unavailable';

export function authDecision(o: {
	pathname: string;
	local: boolean;
	/** Whether this request carries a live session. */
	session: boolean;
	/** null when the login module is not running. */
	settings: { hasPassword: boolean; requireLocal: boolean } | null;
}): AuthDecision {
	if (o.session) return 'allow';
	const s = o.settings;
	if (o.local && !(s?.hasPassword && s.requireLocal)) return 'allow';
	if (!s) return 'unavailable';
	if (!s.hasPassword) return 'setup';
	return isPublicPath(o.pathname) ? 'allow' : 'login';
}
