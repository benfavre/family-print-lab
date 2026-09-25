// Production entry: runs the built app. An error that escapes every handler leaves the process in an
// unknown state (half-written files, a broken database handle), so it is logged with its stack and the
// app exits; the service manager (systemd, Restart=on-failure) starts a fresh one within seconds.
process.on('uncaughtException', (error) => {
	console.error('[print-lab] Stopping after an unexpected error; it will restart:', error);
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	console.error('[print-lab] Unhandled promise rejection:', reason);
});
await import('../build/index.js');
