export const RUNTIME_PLUGIN_FILES = [
  'plugin.json',
  'mcp_config.json',
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'assets/logo.svg',
  'assets/preview.svg',
  'bin/ext-board.mjs',
  'rules/AGENTS.md',
  'skills/agy-ext-swarm/SKILL.md',
  'skills/agy-ext-swarm/references/orchestrator.md',
  'skills/agy-ext-swarm/references/advanced.md',
  'server/dist/index.mjs',
  'server/dist/board.html',
];

export const RELEASE_PLUGIN_FILES = [
  ...RUNTIME_PLUGIN_FILES,
  'scripts/install.mjs',
  'scripts/manifest.mjs',
];
