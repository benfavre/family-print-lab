// How the app trusts a printer on the LAN, for every connection that carries the access code (MQTT
// 8883, FTPS 990, RTSPS 322, port 6000). Printers present a leaf certificate with CN = their serial,
// issued by a Bambu device CA, expect SNI = serial and have no IP SAN (OpenBambuAPI tls.md; ClusterM
// open-bamboo-networking research/10.06-lan-tls-and-access-codes.md). So:
// - SNI = serial, TLS 1.2 at most (ha-bambulab bambu_client.py create_local_ssl_context: "P2S firmware
//   01.02.00.00 never responds to a TLS 1.3 ClientHello"), the bundled Bambu CAs (certs/README.md);
// - Node's hostname check is replaced by our own: the leaf CN must equal the configured serial;
// - when the chain does not verify (device CAs are often missing from bundles), trust on first use:
//   a connection the person started (Test, Add, the env import) pins the leaf's SHA-256 fingerprint,
//   later connections must match it;
// - a chain the CA check accepts is pinned too, so trust on first use is over for that printer: a
//   later peer whose chain does not verify (a LAN impostor with a self-signed CN=serial leaf) gets
//   CERT_CHANGED instead of a fresh pin, and the access code stays home.
// Clients connect with rejectUnauthorized: false and call verifyPrinterCert in the secureConnect
// handler before writing anything, so the access code is never sent to an unverified peer.
import type tls from 'node:tls';

const CERTS = import.meta.glob<string>('./certs/*.pem', {
	query: '?raw',
	import: 'default',
	eager: true
});
/** The bundled Bambu CA certificates (PEM). */
export const BAMBU_CA: string[] = Object.values(CERTS);

export const CERT_CHANGED =
	'This printer’s security certificate changed. If you replaced or reset the printer, press Trust the new certificate.';
export const CERT_UNTRUSTED =
	'Could not check this printer’s security certificate. Test the connection in Integrations → Printers to trust it.';

export function printerTlsOptions(serial: string, ca: (string | Buffer)[] = BAMBU_CA) {
	return {
		servername: serial,
		maxVersion: 'TLSv1.2',
		ca,
		// Decided by verifyPrinterCert once the handshake is done, before anything is written.
		rejectUnauthorized: false,
		checkServerIdentity: () => undefined
	} satisfies tls.ConnectionOptions;
}

export type TrustResult =
	| { ok: true; trust: 'ca' | 'pinned'; fingerprint: string; pin?: string }
	| { ok: false; error: string; fingerprint: string | null };

/** "AB:CD:…" → "abcd…". */
export const normalizeFingerprint = (f: string) => f.replace(/:/g, '').toLowerCase();

/**
 * Decides whether a TLS peer is the printer we mean. `mayPin`: this connection was started by the
 * person (Test, Add, env import), so an unknown chain may be trusted on first use; the result then
 * carries `pin` to store.
 */
export function verifyPrinterCert(
	socket: Pick<tls.TLSSocket, 'authorized' | 'getPeerCertificate'>,
	o: { serial: string; pin: string | null; mayPin?: boolean }
): TrustResult {
	const cert = socket.getPeerCertificate();
	const fingerprint = cert?.fingerprint256 ? normalizeFingerprint(cert.fingerprint256) : null;
	if (!cert || !fingerprint)
		return { ok: false, error: 'The printer sent no security certificate.', fingerprint: null };
	const cn = Array.isArray(cert.subject?.CN) ? cert.subject.CN[0] : cert.subject?.CN;
	if (!cn || cn.toUpperCase() !== o.serial.toUpperCase())
		return {
			ok: false,
			error: `The printer’s certificate names “${String(cn ?? '').slice(0, 40)}”, not the serial number set for it. Check the serial number and the IP address.`,
			fingerprint
		};
	// CA-verified: remember the leaf when nothing is pinned yet (see the header).
	if (socket.authorized)
		return { ok: true, trust: 'ca', fingerprint, ...(o.pin ? {} : { pin: fingerprint }) };
	if (o.pin) {
		return normalizeFingerprint(o.pin) === fingerprint
			? { ok: true, trust: 'pinned', fingerprint }
			: { ok: false, error: CERT_CHANGED, fingerprint };
	}
	if (o.mayPin) return { ok: true, trust: 'pinned', fingerprint, pin: fingerprint };
	return { ok: false, error: CERT_UNTRUSTED, fingerprint };
}
