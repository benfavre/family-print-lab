// Statistics (/analytics): success rate, filament use and cost, printer hours, failure reasons and
// top projects, straight from the jobs table. No tables of its own; reads the hms module's error
// history when that table exists.
import { defineModule } from '../../modules';
import type { AnalyticsFilter, AnalyticsRow, AnalyticsSummary } from '$lib/shared/analytics';
import { rows, summary } from './queries';

export interface AnalyticsService {
	summary(filter: AnalyticsFilter): AnalyticsSummary;
	rows(filter: AnalyticsFilter): AnalyticsRow[];
}

declare module '../../modules' {
	interface ModuleServices {
		analytics: AnalyticsService;
	}
}

export default defineModule({
	key: 'analytics',
	order: 200,
	start(ctx): AnalyticsService {
		return {
			summary: (filter) => summary(ctx.db, filter),
			rows: (filter) => rows(ctx.db, filter)
		};
	}
});
