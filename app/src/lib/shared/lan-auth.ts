// Access from other devices (lan-auth): what the browser sees of the login settings and sessions.

/**
 * 'off': no household password yet, so only this computer can open the app. 'password': other
 * devices log in with the household password. 'profiles': they may also log in with a profile's own
 * PIN (a kid's PIN goes straight into kid mode).
 */
export type AuthMode = 'off' | 'password' | 'profiles';

export interface AuthSessionInfo {
	/** The session's public id (a hash of the cookie, never the cookie itself). */
	id: string;
	profileId: string | null;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
	userAgent: string;
	ip: string;
	/** This browser's own session. */
	current: boolean;
}

/** GET /api/auth. */
export interface AuthStatus {
	mode: AuthMode;
	/** Also ask for a login on this computer (loopback). */
	requireLocal: boolean;
	/** Why the app is reachable from other devices (HOST, ALLOWED_HOSTS), or null when it is not. */
	exposedBy: string | null;
	/** This request came from this computer. */
	local: boolean;
	/** This browser's session, if it logged in. */
	session: { id: string; profileId: string | null } | null;
	/** May change these settings: this computer while it needs no login, or the household password. */
	canManage: boolean;
	/** Profiles that have a PIN (manage only). */
	pins: string[];
	/** Every signed-in device (manage only). */
	sessions: AuthSessionInfo[];
}

/** Password rules, shared by the form and the server. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const PIN_PATTERN = /^\d{4,8}$/;

const SYSTEMS: [RegExp, string][] = [
	[/iPad/, 'iPad'],
	[/iPhone/, 'iPhone'],
	[/Android/, 'Android'],
	[/CrOS/, 'Chromebook'],
	[/Mac OS X|Macintosh/, 'Mac'],
	[/Windows/, 'Windows'],
	[/Linux/, 'Linux']
];
// Order matters: Edge and the desktop app also say Chrome, Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
	[/Electron\//, 'Desktop app'],
	[/Edg\//, 'Edge'],
	[/Firefox\/|FxiOS/, 'Firefox'],
	[/Chrome\/|CriOS/, 'Chrome'],
	[/Safari\//, 'Safari']
];

/** A short, readable name for a signed-in device from its user agent ("Firefox on Android"). */
export function deviceName(userAgent: string): string {
	const os = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
	const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
	if (browser && os) return `${browser} on ${os}`;
	return browser || os || 'Unknown device';
}
