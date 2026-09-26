// Finding printers on the local network over SSDP, only when someone asks ("Find printers"). Bambu
// printers send NOTIFY datagrams to 255.255.255.255:2021 about every 5 s and answer an M-SEARCH
// broadcast there (ClusterM open-bamboo-networking research/06.01-ssdp.md; X1Plus
// installer-clientside/x1p-js/src/x1p.ts; ha-bambulab manifest.json declares the URN). SSDP is
// unauthenticated: anyone can announce any serial at any address, so discovery only suggests; it
// never changes a saved printer, and the TLS policy (tls.ts) is what protects the access code.
import dgram from 'node:dgram';
import { detectModel } from '$lib/shared/printers/models';
import type { DiscoveredPrinter } from '$lib/shared/printers/info';

export const SSDP_PORT = 2021;
export const BAMBU_URN = 'urn:bambulab-com:device:3dprinter:1';
const MAX_DATAGRAM = 2048;
const MAX_VALUE = 200;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const M_SEARCH = `M-SEARCH * HTTP/1.1\r\nHost: 239.255.255.250:1990\r\nST: ${BAMBU_URN}\r\nMAN: "ssdp:discover"\r\nMX: 3\r\n\r\n`;

/** One SSDP datagram → a discovered printer, or null when it is not a Bambu printer or malformed. */
export function parseSsdp(text: string, now = new Date()): Omit<DiscoveredPrinter, 'known'> | null {
	if (text.length > MAX_DATAGRAM) return null;
	const lines = text.split(/\r?\n/);
	if (!/^(NOTIFY \* HTTP\/1\.1|HTTP\/1\.1 200 OK)$/i.test(lines[0]?.trim() ?? '')) return null;
	const h: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const i = line.indexOf(':');
		if (i <= 0) continue;
		const key = line.slice(0, i).trim().toLowerCase();
		const value = line.slice(i + 1).trim();
		if (value.length > MAX_VALUE) return null;
		h[key] = value;
	}
	if ((h.nt ?? h.st) !== BAMBU_URN) return null;
	const host = h.location ?? '';
	const serial = h.usn ?? '';
	if (!IPV4.test(host) || !/^[A-Za-z0-9-]{4,32}$/.test(serial)) return null;
	const ssdpModel = h['devmodel.bambu.com'] ?? '';
	return {
		serial,
		host,
		model: detectModel({ ssdpModel }),
		ssdpModel,
		name: h['devname.bambu.com'] ?? '',
		lanOnly: (h['devconnect.bambu.com'] ?? '').toLowerCase() === 'lan',
		firmware: h['devversion.bambu.com'] || null,
		lastSeen: now.toISOString()
	};
}

/**
 * Listens for printers for `ms` (default 6 s) after one M-SEARCH broadcast. `port` overrides 2021
 * (tests talk to the simulator fleet on 127.0.0.1). When the port cannot be bound (another app has
 * it), returns nothing with a warning.
 */
export function discoverPrinters(
	o: { ms?: number; port?: number } = {}
): Promise<{ printers: Omit<DiscoveredPrinter, 'known'>[]; warning?: string }> {
	const port = o.port ?? SSDP_PORT;
	const ms = Math.min(15_000, Math.max(500, o.ms ?? 6000));
	return new Promise((resolve) => {
		const found = new Map<string, Omit<DiscoveredPrinter, 'known'>>();
		const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
		let done = false;
		const finish = (warning?: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				/* already closed */
			}
			resolve({ printers: [...found.values()], ...(warning && { warning }) });
		};
		const timer = setTimeout(() => finish(), ms);
		socket.on('error', (error: NodeJS.ErrnoException) =>
			finish(
				error.code === 'EADDRINUSE' || error.code === 'EACCES'
					? `Could not listen for printers on UDP port ${port} (another app uses it). Enter the printer's details instead.`
					: `Could not look for printers: ${error.message}`
			)
		);
		socket.on('message', (msg) => {
			if (msg.length > MAX_DATAGRAM) return;
			const p = parseSsdp(msg.toString('utf8'));
			if (p) found.set(p.serial, p);
		});
		socket.bind(port, () => {
			// A failed broadcast (no network, not allowed) is not fatal: printers announce themselves too.
			try {
				socket.setBroadcast(true);
				socket.send(M_SEARCH, port, o.port ? '127.0.0.1' : '255.255.255.255', () => {});
			} catch {
				/* listening still finds printers announcing themselves */
			}
		});
	});
}
