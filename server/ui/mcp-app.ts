/**
 * Single MCP Apps client instance shared by the entrypoint and view modules.
 */
import { App } from '@modelcontextprotocol/ext-apps';

declare const __AGY_EXT_SWARM_VERSION__: string;

export const app = new App(
  {
    name: 'AGY Ext Swarm',
    version: typeof __AGY_EXT_SWARM_VERSION__ !== 'undefined' ? __AGY_EXT_SWARM_VERSION__ : '0.0.0',
  },
  {},
);
