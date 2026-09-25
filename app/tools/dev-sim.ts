// Starts the printer simulator and the app (vite dev) together, already connected. Ctrl+C stops both.
// Uses its own environment for the printer, and a separate database (data/dev-sim.db, seeded from
// data/printlab.db on first run) so simulated prints never touch real data. Pass --real-data to opt out.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const realData = args.includes('--real-data');
const simArgs = args.filter((a) => a !== '--real-data');
const database = realData ? (process.env.DATABASE_URL ?? 'data/printlab.db') : 'data/dev-sim.db';
if (!realData && !fs.existsSync(database) && fs.existsSync('data/printlab.db'))
	fs.copyFileSync('data/printlab.db', database);
console.log(
	realData
		? `[dev] Using your real database (${database}).`
		: `[dev] Using a separate database copy (${database}). Delete it to start fresh from your real data.`
);

const env = {
	...process.env,
	DATABASE_URL: database,
	// Keep the copy's model files and backups apart from the real ones (model cleanup and backup pruning are per folder).
	...(realData ? {} : { MODELS_DIR: 'data/dev-sim-models', BACKUP_DIR: 'data/dev-sim-backups' }),
	BAMBU_HOST: '127.0.0.1',
	BAMBU_PORT: '1883',
	BAMBU_FTP_PORT: '8990',
	BAMBU_TLS: 'off',
	BAMBU_SERIAL: 'SIM-X2D-0001',
	BAMBU_ACCESS_CODE: '12345678',
	BAMBU_NAME: 'Bambu Lab X2D',
	BAMBU_SIMULATED: '1'
};
const children = [
	spawn(process.execPath, ['--import', 'tsx', 'tools/printer-sim.ts', ...simArgs], {
		stdio: 'inherit'
	}),
	spawn('npx', ['vite', 'dev'], { stdio: ['ignore', 'inherit', 'inherit'], env })
];
const stop = () => children.forEach((c) => c.kill('SIGINT'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => ((process.exitCode = code ?? 0), stop()));
