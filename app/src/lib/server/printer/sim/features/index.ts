// Simulator features, in order. Packages add one import and one array entry each, at the end.
import type { SimFeature } from '../core';
import { core } from './core';
import { camera } from './camera';

export const FEATURES: SimFeature[] = [core, camera];
