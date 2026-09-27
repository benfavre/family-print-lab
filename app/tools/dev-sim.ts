// Starts a simulated printer fleet (an X2D, a P1S and an A1 mini) and the app (vite dev) together,
// already connected. Ctrl+C stops both. --single keeps just the X2D. Uses a separate database
// (data/dev-sim.db, seeded from data/printlab.db on first run) so simulated prints never touch real
// data; pass --real-data to opt out. --first-run starts from an empty database (data/dev-first-run.db,
// wiped on each start) with no printer registered, so the setup guide opens and Find printers sees the
// simulators over SSDP. Other arguments go to the simulator (see tools/printer-sim.ts).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const realData = args.includes('--real-data');
const single = args.includes('--single');
const firstRun = args.includes('--first-run');
const simArgs = args.filter((a) => !['--real-data', '--single', '--first-run'].includes(a));
const database = firstRun
	? 'data/dev-first-run.db'
	: realData
		? (process.env.DATABASE_URL ?? 'data/printlab.db')
		: 'data/dev-sim.db';
if (firstRun)
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${database}${suffix}`, { force: true });
else if (!realData && !fs.existsSync(database) && fs.existsSync('data/printlab.db'))
	fs.copyFileSync('data/printlab.db', database);
console.log(
	firstRun
		? `[dev] First run on an empty database (${database}). In the setup guide, add a simulator by hand: 127.0.0.1, serial SIM-X2D-0001, access code 12345678, advanced: port 1883, file port 8990, TLS off, simulator on.`
		: realData
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
	...(firstRun && {
		MODELS_DIR: 'data/dev-first-run-models',
		BACKUP_DIR: 'data/dev-first-run-backups',
		LEGACY_IMPORT: '/nonexistent/legacy.json',
		BAMBU_HOST: '',
		BAMBU_SERIAL: '',
		BAMBU_ACCESS_CODE: ''
	}),
	// Registered (and kept up to date) in the printers table on every start (none on a first run).
	PRINTLAB_PRINTERS: JSON.stringify(
		firstRun
			? []
			: fleet.map((model, i) => ({
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
			// Each printer on a fake smart plug (Integrations → Home automation: http://127.0.0.1:8300…).
			'--plugs',
			'8300',
			// A first run finds the simulators the way it finds real printers (Find printers, SSDP).
			...(firstRun ? ['--ssdp', '2021'] : []),
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
