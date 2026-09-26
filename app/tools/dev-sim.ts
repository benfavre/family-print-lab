// Starts a simulated printer fleet (an X2D, a P1S and an A1 mini) and the app (vite dev) together,
// already connected. Ctrl+C stops both. --single keeps just the X2D. Uses a separate database
// (data/dev-sim.db, seeded from data/printlab.db on first run) so simulated prints never touch real
// data; pass --real-data to opt out. Other arguments go to the simulator (see tools/printer-sim.ts).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const realData = args.includes('--real-data');
const single = args.includes('--single');
const simArgs = args.filter((a) => a !== '--real-data' && a !== '--single');
const database = realData ? (process.env.DATABASE_URL ?? 'data/printlab.db') : 'data/dev-sim.db';
if (!realData && !fs.existsSync(database) && fs.existsSync('data/printlab.db'))
	fs.copyFileSync('data/printlab.db', database);
console.log(
	realData
		? `[dev] Using your real database (${database}).`
		: `[dev] Using a separate database copy (${database}). Delete it to start fresh from your real data.`
);

const fleet = single ? ['N6'] : ['N6', 'C12', 'N1'];
const port = 1883;
const ftpPort = 8990;
// Same serials as tools/printer-sim.ts gives them (sim/fleet.ts).
const serials: Record<string, string> = {
	N6: 'SIM-X2D-0001',
	C12: 'SIM-P1S-0001',
	N1: 'SIM-A1MINI-0001'
};
const names: Record<string, string> = {
	N6: 'Bambu Lab X2D',
	C12: 'Bambu Lab P1S',
	N1: 'Bambu Lab A1 mini'
};

const env = {
	...process.env,
	DATABASE_URL: database,
	// Keep the copy's model files and backups apart from the real ones (model cleanup and backup pruning are per folder).
	...(realData ? {} : { MODELS_DIR: 'data/dev-sim-models', BACKUP_DIR: 'data/dev-sim-backups' }),
	// Registered (and kept up to date) in the printers table on every start.
	PRINTLAB_PRINTERS: JSON.stringify(
		fleet.map((model, i) => ({
			name: names[model],
			model,
			host: '127.0.0.1',
			port: port + i,
			ftpPort: ftpPort + i,
			serial: serials[model],
			accessCode: '12345678',
			tls: false,
			simulated: true
		}))
	)
};
const children = [
	spawn(
		process.execPath,
		[
			'--import',
			'tsx',
			'tools/printer-sim.ts',
			'--fleet',
			fleet.join(','),
			'--port',
			String(port),
			'--ftp-port',
			String(ftpPort),
			...simArgs
		],
		{ stdio: 'inherit' }
	),
	spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'dev'], {
		stdio: ['ignore', 'inherit', 'inherit'],
		env
	})
];
const stop = () => children.forEach((c) => c.kill('SIGINT'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => ((process.exitCode = code ?? 0), stop()));
