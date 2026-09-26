// A fake printlab-slicer for engine.test.ts: speaks Slicer Engine Protocol v1 over stdin/stdout with
// canned results, so the client is tested without the native build. Behaviour comes from env:
//   FAKE_MAJOR   protocol major it claims (default 1)
//   FAKE_CAPS    comma-separated capabilities (default: slice,slice.cancel,profiles.list)
//   FAKE_STRAY   1: print a line of non-protocol text to stdout before answering hello
// Methods: engine.hello, engine.ping, engine.shutdown; slice (three $/progress, cancellable with
// $/cancel; plate 0 never finishes on its own); profiles.list (a 3 MB answer written in small pieces);
// mesh.put with meshId "crash" (exits without answering).
import readline from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const fail = (id, code, message) => send({ id, error: { code, message, data: { message } } });
const running = new Map();

process.stderr.write('fake engine: starting (logs go to stderr)\n');

const handlers = {
	'engine.hello': (id, params) => {
		if (process.env.FAKE_STRAY === '1') process.stdout.write('upstream says hello on stdout\n');
		send({
			id,
			result: {
				engine: 'printlab-slicer',
				version: '0.0.0-fake',
				protocol: { major: Number(process.env.FAKE_MAJOR ?? 1), minor: 0 },
				upstream: { name: 'BambuStudio', tag: 'v02.08.02.61', commit: null },
				patchQueue: { version: 0, hash: '', patches: [] },
				capabilities: (process.env.FAKE_CAPS ?? 'slice,slice.cancel,profiles.list')
					.split(',')
					.filter(Boolean),
				profiles: null,
				workDir: params.workDir
			}
		});
	},
	'engine.ping': (id) => send({ id, result: { ok: true } }),
	'engine.shutdown': (id) => {
		send({ id, result: { ok: true } });
		process.exit(0);
	},
	slice: (id, params) => {
		let step = 0;
		const timer = setInterval(() => {
			step++;
			if (step <= 3) {
				send({
					method: '$/progress',
					params: { id, progress: { stage: 'slicing', percent: step * 30, message: `Step ${step}` } }
				});
				process.stderr.write(`fake engine: step ${step}\n`);
				return;
			}
			if (params.plate === 0) return;
			clearInterval(timer);
			running.delete(id);
			send({
				id,
				result: { plate: params.plate, seconds: 600, layers: 50, filaments: [], objects: [], warnings: [] }
			});
		}, 5);
		running.set(id, timer);
	},
	'profiles.list': (id) => {
		const line = `${JSON.stringify({
			jsonrpc: '2.0',
			id,
			result: { presets: [{ name: 'x'.repeat(3 * 1024 * 1024), kind: 'printer' }] }
		})}\n`;
		// Written in uneven pieces so the client sees partial lines.
		let at = 0;
		const next = () => {
			if (at >= line.length) return;
			const size = 1 + ((at * 7919) % 65536);
			process.stdout.write(line.slice(at, at + size), next);
			at += size;
		};
		next();
	},
	'mesh.put': (id, params) => {
		if (params.meshId === 'crash') process.exit(3);
		fail(id, 1002, 'No such mesh.');
	}
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
	const msg = JSON.parse(line);
	if (msg.method === '$/cancel') {
		const timer = running.get(msg.params.id);
		if (timer) {
			clearInterval(timer);
			running.delete(msg.params.id);
			fail(msg.params.id, 1030, 'Slicing was cancelled.');
		}
		return;
	}
	const handler = handlers[msg.method];
	if (handler) handler(msg.id, msg.params);
	else fail(msg.id, -32601, `Unknown method ${msg.method}.`);
});
