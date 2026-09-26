// Throwaway certificates for TLS tests: a test CA and leaves with a chosen CN (printers use CN = serial),
// made with the system openssl. Tests skip when openssl is not installed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestCert {
	key: string;
	cert: string;
}

export function hasOpenssl(): boolean {
	try {
		execFileSync('openssl', ['version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

/** A self-signed CA, and a function that issues leaves (or self-signed ones with `selfSigned`). */
export function testCa(name = 'Print Lab Test CA') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-lab-certs-'));
	const file = (f: string) => path.join(dir, f);
	const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe', cwd: dir });
	run([
		'req',
		'-x509',
		...EC,
		'-keyout',
		'ca.key',
		'-out',
		'ca.pem',
		'-days',
		'2',
		'-subj',
		`/CN=${name}`
	]);
	let n = 0;
	return {
		ca: fs.readFileSync(file('ca.pem'), 'utf8'),
		leaf(cn: string, o: { selfSigned?: boolean } = {}): TestCert {
			const id = `leaf${n++}`;
			if (o.selfSigned)
				run([
					'req',
					'-x509',
					...EC,
					'-keyout',
					`${id}.key`,
					'-out',
					`${id}.pem`,
					'-days',
					'2',
					'-subj',
					`/CN=${cn}`
				]);
			else {
				run(['req', ...EC, '-keyout', `${id}.key`, '-out', `${id}.csr`, '-subj', `/CN=${cn}`]);
				run([
					'x509',
					'-req',
					'-in',
					`${id}.csr`,
					'-CA',
					'ca.pem',
					'-CAkey',
					'ca.key',
					'-CAcreateserial',
					'-out',
					`${id}.pem`,
					'-days',
					'2'
				]);
			}
			return {
				key: fs.readFileSync(file(`${id}.key`), 'utf8'),
				cert: fs.readFileSync(file(`${id}.pem`), 'utf8')
			};
		},
		cleanup() {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
}
