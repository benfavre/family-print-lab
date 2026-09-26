// Several simulated printers at once (dev:sim, e2e, integration tests), each on its own MQTT and FTP
// port, optionally announcing themselves over SSDP like real printers do (NOTIFY datagrams, format per
// ClusterM open-bamboo-networking research/06.01-ssdp.md), sent to 127.0.0.1:<ssdpPort>.
import dgram from 'node:dgram';
import { createSimulator, type SimOptions, type Simulator } from './core';
import { PRINTER_MODELS } from '$lib/shared/printers/models';

export interface FleetPrinter {
	sim: Simulator;
	options: SimOptions;
	port: number;
	ftpPort: number;
}

export interface Fleet {
	printers: FleetPrinter[];
	host: string;
	ssdpPort: number | null;
	/** The PRINTLAB_PRINTERS value that registers this fleet in the app. */
	env(): string;
	/** Sends one round of SSDP NOTIFY datagrams now. */
	notify(): void;
	close(): Promise<void>;
}

/** One SSDP NOTIFY as Bambu printers send it. */
export function ssdpNotify(o: {
	host: string;
	serial: string;
	model: string;
	name: string;
	firmware: string;
}): string {
	return [
		'NOTIFY * HTTP/1.1',
		'Host: 239.255.255.250:1990',
		'Server: UPnP/1.0',
		`Location: ${o.host}`,
		'NT: urn:bambulab-com:device:3dprinter:1',
		'NTS: ssdp:alive',
		`USN: ${o.serial}`,
		'Cache-Control: max-age=1800',
		`DevModel.bambu.com: ${o.model}`,
		`DevName.bambu.com: ${o.name}`,
		'DevConnect.bambu.com: lan',
		'DevBind.bambu.com: free',
		'Devseclink.bambu.com: secure',
		'DevInf.bambu.com: wlan0',
		`DevVersion.bambu.com: ${o.firmware}`,
		'DevCap.bambu.com: 1',
		'',
		''
	].join('\r\n');
}

export async function createFleet(o: {
	printers: SimOptions[];
	host?: string;
	basePort?: number;
	baseFtpPort?: number;
	ssdpPort?: number;
	ssdpIntervalMs?: number;
}): Promise<Fleet> {
	const host = o.host ?? '127.0.0.1';
	const serials = new Set<string>();
	const printers: FleetPrinter[] = [];
	for (const [i, options] of o.printers.entries()) {
		const model = PRINTER_MODELS[options.model ?? 'N6'];
		// Unique serials: SIM-X2D-0001, SIM-X2D-0002…
		let n = 1;
		let serial = options.serial ?? '';
		while (!serial || serials.has(serial))
			serial = `SIM-${model.short.replace(/\W/g, '').toUpperCase()}-${String(n++).padStart(4, '0')}`;
		serials.add(serial);
		const sim = createSimulator({ ...options, serial });
		const port = await sim.listen(
			o.basePort ? o.basePort + i : 0,
			host,
			o.baseFtpPort ? o.baseFtpPort + i : 0
		);
		printers.push({ sim, options: { ...options, serial }, port, ftpPort: sim.ftpPort });
	}
	const udp = o.ssdpPort ? dgram.createSocket('udp4') : null;
	const notify = () => {
		if (!udp || !o.ssdpPort) return;
		for (const p of printers) {
			udp.send(
				ssdpNotify({
					host,
					serial: p.sim.serial,
					model: p.sim.model.code,
					name: p.sim.sim.name,
					firmware: p.sim.firmware
				}),
				o.ssdpPort,
				'127.0.0.1'
			);
		}
	};
	const timer = udp ? setInterval(notify, o.ssdpIntervalMs ?? 5000) : undefined;
	timer?.unref?.();
	if (udp) setTimeout(notify, 50).unref?.();
	return {
		printers,
		host,
		ssdpPort: o.ssdpPort ?? null,
		env: () =>
			JSON.stringify(
				printers.map((p) => ({
					name: p.sim.sim.name,
					model: p.sim.model.code,
					host,
					port: p.port,
					ftpPort: p.ftpPort,
					serial: p.sim.serial,
					accessCode: p.sim.accessCode,
					tls: false,
					simulated: true
				}))
			),
		notify,
		async close() {
			clearInterval(timer);
			udp?.close();
			await Promise.all(printers.map((p) => p.sim.close()));
		}
	};
}
