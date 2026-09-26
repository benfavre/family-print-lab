// The printer simulator lives in sim/ (core.ts, fleet.ts, states/, features/); this keeps the old import path.
export { createSimulator, type Simulator, type SimOptions, type SimPrinter } from './sim/core';
export { createFleet, type Fleet } from './sim/fleet';
