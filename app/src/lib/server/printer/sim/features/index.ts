// Simulator features, in order. Packages add one import and one array entry each, at the end.
import type { SimFeature } from '../core';
import { core } from './core';
import { camera } from './camera';
import { ams } from './ams';
import { controls } from './controls';
import { hms } from './hms';
import { notifications } from './notifications';
import { power } from './power';
import { maintenance } from './maintenance';
import { vision } from './vision';
import { slicerCalibration } from './slicer-calibration';

export const FEATURES: SimFeature[] = [
	core,
	camera,
	ams,
	controls,
	hms,
	notifications,
	power,
	maintenance,
	vision,
	slicerCalibration
];
