import { defineConfig } from '@playwright/test';

// End-to-end tests run the production build against a throwaway database seeded from the test
// fixture, with a fast printer simulator attached. They never touch data/.
const PORT = 4173;
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 60_000,
	reporter: [['list']],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		channel: 'chrome',
		trace: 'retain-on-failure',
		launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
	},
	webServer: [
		{
			// No random failures in tests: the simulator otherwise fails ~15% of prints on purpose.
			command:
				'npx tsx tools/printer-sim.ts --port 18831 --ftp-port 18991 --control 18661 --speed 120 --fail-rate 0',
			url: 'http://127.0.0.1:18661',
			reuseExistingServer: false,
			stdout: 'ignore'
		},
		{
			command: `rm -rf .e2e && mkdir -p .e2e && BUILD_DIR=.e2e/build npm run build && node .e2e/build`,
			url: `http://127.0.0.1:${PORT}`,
			reuseExistingServer: false,
			timeout: 240_000,
			env: {
				HOST: '127.0.0.1',
				PORT: String(PORT),
				DATABASE_URL: '.e2e/test.db',
				BACKUP_DIR: '.e2e/backups',
				LEGACY_IMPORT: 'src/lib/server/__fixtures__/legacy-v1.json',
				LAB_AI: 'off',
				BODY_SIZE_LIMIT: '110M',
				// Never touch the real AI sign-ins from tests.
				CLAUDE_BIN: '/nonexistent/claude',
				CODEX_BIN: '/nonexistent/codex',
				BAMBU_HOST: '127.0.0.1',
				BAMBU_PORT: '18831',
				BAMBU_FTP_PORT: '18991',
				BAMBU_TLS: 'off',
				BAMBU_SERIAL: 'SIM-X2D-0001',
				BAMBU_ACCESS_CODE: '12345678',
				BAMBU_SIMULATED: '1'
			}
		}
	]
});
