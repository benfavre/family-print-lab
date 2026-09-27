import net from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createSimulator } from '../core';
import { attachPlug } from './power';

async function connect(port: number) {
	const socket = net.connect(port, '127.0.0.1');
	await once(socket, 'connect');
	socket.resume();
	return socket;
}

async function expectReserved(port: number) {
	const other = net.createServer();
	const error = once(other, 'error');
	other.listen(port, '127.0.0.1');
	const [problem] = await error;
	expect(problem.code).toBe('EADDRINUSE');
	other.close();
}

it('keeps both ports reserved while unpowered, rejects sessions and reboots on the same ports', async () => {
	const printer = createSimulator({ model: 'C12', log: () => {} });
	await printer.listen(0);
	const ports = [printer.port, printer.ftpPort];
	const plug = attachPlug(printer, { bootMs: 1 });
	const clients: net.Socket[] = [];
	try {
		for (const port of ports) clients.push(await connect(port));
		const closed = clients.map((s) => once(s, 'close'));
		await plug.set(false);
		await Promise.all(closed);
		for (const port of ports) {
			await expectReserved(port);
			const rejected = net.connect(port, '127.0.0.1');
			clients.push(rejected);
			const bytes: Buffer[] = [];
			rejected.on('data', (data) => bytes.push(data));
			await once(rejected, 'close');
			expect(bytes).toEqual([]);
		}
		await plug.set(true);
		expect([printer.port, printer.ftpPort]).toEqual(ports);
		const ftp = net.connect(printer.ftpPort, '127.0.0.1');
		clients.push(ftp);
		const [greeting] = await once(ftp, 'data');
		expect(greeting.toString()).toMatch(/^220 /);
	} finally {
		for (const socket of clients) socket.destroy();
		await printer.close();
	}
});
