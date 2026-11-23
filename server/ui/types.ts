export * from '../shared/types.js';
import type { SwarmSnapshot, SwarmState } from '../shared/types.js';

export interface Snapshot extends Omit<SwarmSnapshot, 'swarm'> {
  swarm: SwarmState | null;
}
