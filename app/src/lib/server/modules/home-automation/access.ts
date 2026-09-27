// Who may read /api/ha/printers and /metrics: this computer (by socket address, never a header that a
// client can set), a request carrying the Home Assistant token, or a logged-in session when the
// lan-auth package is present. The token is shown once and only its SHA-256 hash is stored.
import crypto from 'node:crypto';

export function newToken(): { token: string; hash: string } {
	const token = `plab_${crypto.randomBytes(24).toString('base64url')}`;
	return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
	return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented token with the stored hash. */
export function tokenMatches(presented: string | null, storedHash: string | null): boolean {
	if (!presented || !storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
	const a = Buffer.from(hashToken(presented), 'hex');
	const b = Buffer.from(storedHash, 'hex');
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 127.0.0.1, ::1 and the IPv4-mapped form of 127.0.0.1 (a dual-stack socket reports that). */
export function isLoopback(address: string | null | undefined): boolean {
	if (!address) return false;
	return /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i.test(address);
}

/** The bearer token of an Authorization header. */
export function bearer(header: string | null): string | null {
	const m = header?.match(/^Bearer\s+(\S+)\s*$/i);
	return m ? m[1] : null;
}

export interface AccessRequest {
	getClientAddress(): string;
	request: Request;
	locals: object;
}

/**
 * The client's socket address; null when the adapter cannot tell (then the request is not local).
 * adapter-node reads a header instead when ADDRESS_HEADER is set, so then nothing counts as local.
 */
function clientAddress(event: AccessRequest): string | null {
	if (process.env.ADDRESS_HEADER) return null;
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

/**
 * A logged-in session from the lan-auth package (not merged yet: it is expected to set
 * `locals.session`); a kid-mode browser never counts.
 */
function hasSession(locals: object): boolean {
	const l = locals as { session?: unknown; kid?: unknown };
	return !!l.session && !l.kid;
}

export function allowed(event: AccessRequest, tokenHash: string | null): boolean {
	return (
		isLoopback(clientAddress(event)) ||
		tokenMatches(bearer(event.request.headers.get('authorization')), tokenHash) ||
		hasSession(event.locals)
	);
}
