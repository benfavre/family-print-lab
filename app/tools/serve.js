// Production entry: runs the built app, but keeps serving if a stray error escapes a request (for example
// a static file removed by a rebuild while the server runs). Such errors are logged instead of stopping
// the whole app; restart after a rebuild to pick up the new files.
process.on('uncaughtException', (error) => {
	console.error(`[print-lab] Kept running after an unexpected error: ${error?.message ?? error}`);
});
await import('../build/index.js');
