// A module the way a package writes one, for the registry tests (folders starting with "__" are not
// loaded by the app). It counts finished prints, remembers a setting, offers a service, adds an
// Integrations row and lets kid mode read one path.
import { z } from 'zod';
import { defineModule } from '../../modules';

export interface ExampleService {
	finished(): number;
	greeting(): string;
}

declare module '../../modules' {
	interface ModuleServices {
		example: ExampleService;
	}
}

declare module '../../events' {
	interface LabEventMap {
		'example.hello': { text: string };
	}
}

let stopped = 0;
export const stops = () => stopped;

export default defineModule({
	key: 'example',
	order: 50,
	kidReads: [/^\/api\/example\/public$/],
	start(ctx) {
		const settings = ctx.settings(z.object({ greeting: z.string().max(40) }), {
			greeting: 'Hello'
		});
		let finished = 0;
		ctx.bus.on('print.finished', () => {
			finished++;
			ctx.bus.emit('example.hello', { text: `${settings.get().greeting}, print done` });
		});
		return {
			finished: () => finished,
			greeting: () => settings.get().greeting
		};
	},
	stop() {
		stopped++;
	},
	integrations: () => [
		{
			id: 'example',
			kind: 'module',
			name: 'Example',
			via: 'A test module',
			available: true,
			detail: 'Always ready.',
			powers: ['Counting prints'],
			setup: []
		}
	]
});
