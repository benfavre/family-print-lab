// Family Print Lab desktop: runs the app's own server inside Electron and shows it in a window.
// Data lives in the per-user app folder; updates come from GitHub Releases (electron-updater).
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SERVER = path.join(__dirname, 'server');
const DATA = app.getPath('userData');
const CONFIG = path.join(DATA, 'printlab.env');
const LOG = path.join(DATA, 'desktop.log');

const log = (...parts) => {
	const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
	try {
		fs.appendFileSync(LOG, line);
	} catch {
		/* the folder may not exist yet */
	}
	process.stdout.write(line);
};

if (!app.requestSingleInstanceLock()) app.quit();

let window = null;
let origin = null;

/** Settings the web app reads from its environment (printer, AI keys…), from printlab.env. */
function loadConfig() {
	if (!fs.existsSync(CONFIG)) return;
	for (const raw of fs.readFileSync(CONFIG, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		const value = line
			.slice(eq + 1)
			.trim()
			.replace(/^(['"])(.*)\1$/, '$2');
		if (value && process.env[key] === undefined) process.env[key] = value;
	}
}

function freePort(preferred) {
	return new Promise((resolve) => {
		const tryPort = (port) => {
			const probe = net.createServer();
			probe.once('error', () =>
				port === 0 ? resolve(0) : tryPort(port < preferred + 10 ? port + 1 : 0)
			);
			probe.once('listening', () => {
				const { port: chosen } = probe.address();
				probe.close(() => resolve(chosen));
			});
			probe.listen(port, '127.0.0.1');
		};
		tryPort(preferred);
	});
}

async function waitForServer(url, timeoutMs = 60_000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			const r = await fetch(url, { redirect: 'manual' });
			if (r.status < 500) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('The app did not start in time.');
}

async function startServer() {
	fs.mkdirSync(DATA, { recursive: true });
	loadConfig();
	const port = await freePort(Number(process.env.PORT) || 8765);
	Object.assign(process.env, {
		HOST: '127.0.0.1',
		PORT: String(port),
		DATABASE_URL: process.env.DATABASE_URL || path.join(DATA, 'printlab.db'),
		BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT || '110M',
		// Phone approvals through familyprintlab.app. Nothing is sent until a parent links on the
		// Family page; `CLOUD_URL=` (empty) in the settings file hides it.
		CLOUD_URL: process.env.CLOUD_URL ?? 'https://familyprintlab.app',
		PRINT_LAB_DESKTOP: '1'
	});
	// The server loads drizzle/ and resources/ relative to its working directory.
	process.chdir(SERVER);
	await import(pathToFileURL(path.join(SERVER, 'build', 'index.js')).href);
	origin = `http://127.0.0.1:${port}`;
	await waitForServer(origin);
	// The server stops the process on SIGINT/SIGTERM; in the desktop app a signal means "quit", so
	// Electron can finish its own shutdown (including installing a downloaded update).
	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.removeAllListeners(signal);
		process.on(signal, () => app.quit());
	}
	log(`Family Print Lab ${app.getVersion()} ready on ${origin}, data in ${DATA}`);
}

const WINDOW_STATE = path.join(DATA, 'window.json');
function savedBounds() {
	try {
		const b = JSON.parse(fs.readFileSync(WINDOW_STATE, 'utf8'));
		// Only reuse a position that is still on one of the screens.
		const { screen } = require('electron');
		const visible = screen
			.getAllDisplays()
			.some(
				({ workArea: a }) =>
					b.x >= a.x - 50 &&
					b.y >= a.y - 50 &&
					b.x < a.x + a.width - 100 &&
					b.y < a.y + a.height - 100
			);
		return {
			width: b.width,
			height: b.height,
			...(visible ? { x: b.x, y: b.y } : {}),
			maximized: !!b.maximized
		};
	} catch {
		return { width: 1320, height: 880, maximized: false };
	}
}

function createWindow() {
	const bounds = savedBounds();
	window = new BrowserWindow({
		...bounds,
		minWidth: 380,
		minHeight: 560,
		title: 'Family Print Lab',
		backgroundColor: '#0c1018',
		autoHideMenuBar: process.platform !== 'darwin',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	// Links to other sites (models, the cloud, docs) open in the normal browser.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith(origin)) void shell.openExternal(url);
		return { action: url.startsWith(origin) ? 'allow' : 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (!url.startsWith(origin)) {
			event.preventDefault();
			void shell.openExternal(url);
		}
	});
	if (bounds.maximized) window.maximize();
	const remember = () => {
		if (!window || window.isMinimized()) return;
		const saved = {
			...(window.isMaximized() ? savedBounds() : window.getBounds()),
			maximized: window.isMaximized()
		};
		try {
			fs.writeFileSync(WINDOW_STATE, JSON.stringify(saved));
		} catch {
			/* not important */
		}
	};
	window.on('close', remember);
	window.on('closed', () => (window = null));
	void window.loadURL(origin);
}

function openConfig() {
	if (!fs.existsSync(CONFIG)) {
		const example = path.join(SERVER, 'env.example');
		fs.writeFileSync(
			CONFIG,
			`# Family Print Lab settings. Save, then restart the app (File > Restart).\n\n${fs.existsSync(example) ? fs.readFileSync(example, 'utf8').replace(/^(HOST|PORT|DATABASE_URL|BODY_SIZE_LIMIT)=.*$/gm, '# $&  (set by the desktop app)') : ''}`
		);
	}
	void shell.openPath(CONFIG);
}

function buildMenu() {
	const template = [
		...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
		{
			label: 'File',
			submenu: [
				{ label: 'Printer and AI settings…', click: openConfig },
				{ label: 'Open data folder', click: () => void shell.openPath(DATA) },
				{ type: 'separator' },
				{ label: 'Restart', click: () => (app.relaunch(), app.exit(0)) },
				process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
			]
		},
		{ role: 'editMenu' },
		{ role: 'viewMenu' },
		{
			role: 'help',
			submenu: [
				{ label: 'Check for updates', click: () => checkForUpdates(true) },
				{
					label: 'Family Print Lab website',
					click: () => void shell.openExternal('https://familyprintlab.app')
				},
				{
					label: 'Project page',
					click: () => void shell.openExternal('https://github.com/benfavre/family-print-lab')
				},
				{ label: `Version ${app.getVersion()}`, enabled: false }
			]
		}
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Updates (GitHub Releases) ----------

let updater = null;
function checkForUpdates(manual = false) {
	if (!app.isPackaged) {
		if (manual)
			void dialog.showMessageBox({
				message: 'Updates are checked in the installed app only.'
			});
		return;
	}
	if (!updater) {
		updater = require('electron-updater').autoUpdater;
		// For testing updates against a local server (a folder with latest-linux.yml and the files).
		if (process.env.PRINT_LAB_UPDATE_FEED)
			updater.setFeedURL({
				provider: 'generic',
				url: process.env.PRINT_LAB_UPDATE_FEED
			});
		// One line per event: electron-updater's errors otherwise include whole HTTP responses.
		const line = (m) => log('update', String(m?.message ?? m).split('\n')[0]);
		updater.logger = { info: line, warn: line, error: line };
		updater.on('update-downloaded', async (info) => {
			const { response } = await dialog.showMessageBox({
				type: 'info',
				buttons: ['Restart now', 'Later'],
				defaultId: 0,
				message: `Family Print Lab ${info.version} is ready`,
				detail: 'Restart to use the new version. Your projects are kept.'
			});
			if (response === 0) updater.quitAndInstall();
		});
		updater.on('update-not-available', () => {
			if (manualCheck) void dialog.showMessageBox({ message: 'You have the latest version.' });
		});
		updater.on('error', (e) => {
			log('update error', e?.message ?? e);
			if (manualCheck)
				void dialog.showMessageBox({
					type: 'warning',
					message: 'Could not check for updates right now.'
				});
		});
	}
	manualCheck = manual;
	updater.checkForUpdates().catch(() => {});
}
let manualCheck = false;

// ---------- Life cycle ----------

process.on('uncaughtException', (error) => {
	log('unexpected error', error?.stack ?? error);
	dialog.showErrorBox('Family Print Lab hit a problem', 'It will restart. Your projects are safe.');
	app.relaunch();
	app.exit(1);
});

app.on('second-instance', () => {
	if (window) {
		if (window.isMinimized()) window.restore();
		window.focus();
	}
});

app.whenReady().then(async () => {
	buildMenu();
	try {
		await startServer();
	} catch (error) {
		log('could not start', error?.stack ?? error);
		dialog.showErrorBox('Family Print Lab could not start', String(error?.message ?? error));
		app.exit(1);
		return;
	}
	createWindow();
	checkForUpdates();
	setInterval(() => checkForUpdates(), 6 * 3600_000);
	app.on('activate', () => {
		if (!BrowserWindow.getAllWindows().length) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

// Let the server flush tasks and close the database cleanly.
// Flush tasks and close the database cleanly, without exiting: electron-updater installs a
// downloaded update on quit, after this.
app.on('will-quit', () => {
	try {
		globalThis[Symbol.for('family-print-lab.runtime')]?.shutdown();
	} catch (error) {
		log('shutdown', error?.message ?? error);
	}
});
