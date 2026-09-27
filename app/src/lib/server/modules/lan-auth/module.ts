// lan-auth: optional login for other devices on the home network. Off by default (the app listens on
// 127.0.0.1 and this computer needs no login); see hooks/auth.ts for who must log in.
import { defineModule } from '../../modules';
import { LanAuth } from './service';
import { authSettingsSchema, AUTH_DEFAULTS } from './validation';

declare module '../../modules' {
	interface ModuleServices {
		'lan-auth': LanAuth;
	}
}

let timer: ReturnType<typeof setInterval> | undefined;

export default defineModule({
	key: 'lan-auth',
	// Early, so the auth handle has it before anything else is reachable.
	order: 10,
	start(ctx) {
		const store = ctx.settings(authSettingsSchema, AUTH_DEFAULTS);
		const auth = new LanAuth(ctx.db, store, ctx.env);
		// A forgotten password with "Require login here too" on: start once with PRINTLAB_AUTH_RESET=1.
		if (ctx.env.PRINTLAB_AUTH_RESET === '1') {
			store.set(AUTH_DEFAULTS);
			auth.sessions.endAll();
			ctx.log('Login for other devices was reset: no password, every device logged out.');
		}
		auth.sessions.prune();
		timer = setInterval(() => auth.sessions.prune(), 60 * 60_000);
		timer.unref?.();
		return auth;
	},
	stop() {
		clearInterval(timer);
		timer = undefined;
	}
});
