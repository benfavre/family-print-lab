// The notifications service for the API routes (503 when the module is off).
import type { Runtime } from '../../runtime';
import { AppError } from '../../validation';
import type { NotificationsService } from './module';

export function notifications(rt: Runtime): NotificationsService {
	const service = rt.module('notifications');
	if (!service) throw new AppError(503, 'Notifications are not running on this computer.');
	return service;
}
