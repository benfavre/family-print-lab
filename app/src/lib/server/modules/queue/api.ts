// The queue service for API routes (a 503 when the module is off or failed to start).
import type { Runtime } from '../../runtime';
import { AppError } from '../../validation';
import type { Queue } from './service';

export function queueOf(rt: Runtime): Queue {
	const queue = rt.module('queue');
	if (!queue) throw new AppError(503, 'The print queue is not running.');
	return queue;
}
