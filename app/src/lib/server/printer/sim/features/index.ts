// Simulator features, in order. Packages add one import and one array entry each, at the end.
import type { SimFeature } from '../core';
import { core } from './core';
import { controls } from './controls';

export const FEATURES: SimFeature[] = [core, controls];
