import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveBrainDir } from './coordinator-usage.js';
import { SwarmRuntime } from './runner.js';
import { SwarmStore } from './store.js';
import { registerAppTools } from './tools/app-tools.js';
import { APP_MIME_TYPE, APP_RESOURCE_URI, type ToolContext } from './tools/common.js';
import { registerModelTools } from './tools/model-tools.js';

function canonicalPath(p: string): string {
  const abs = resolve(p);
  return existsSync(abs) ? realpathSync(abs) : abs;
}

function parseCliArgs(argv: string[]): { dataDir: string; pluginRoot: string } {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  let dataDir = join(homedir(), '.gemini', 'config', 'plugins', 'agy-ext-swarm', '.data');
  let pluginRoot = resolve(selfDir, '..', '..');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg.startsWith('--plugin-root=')) {
      pluginRoot = arg.slice('--plugin-root='.length);
    } else if (arg === '--plugin-root' && argv[i + 1]) {
      pluginRoot = argv[++i];
    }
  }

  return {
    dataDir: canonicalPath(dataDir),
    pluginRoot: resolve(pluginRoot),
  };
}

function loadBoardHtml(pluginRoot: string): string {
  const overridePath = process.env.EXT_SWARM_APP_HTML;
  const htmlPath = overridePath
    ? resolve(overridePath)
    : join(pluginRoot, 'server', 'dist', 'board.html');
  if (!existsSync(htmlPath)) {
    return `<!doctype html><html><body><p>AGY Ext Swarm UI bundle not found at ${htmlPath}. Run pnpm build in server/.</p></body></html>`;
  }
  return readFileSync(htmlPath, 'utf8');
}

async function main(): Promise<void> {
  const { dataDir, pluginRoot } = parseCliArgs(process.argv.slice(2));
  const brainDir = resolveBrainDir(dataDir);
  const store = new SwarmStore(dataDir);
  const runtime = new SwarmRuntime(store, pluginRoot);

  const server = new McpServer({
    name: 'agy-ext-swarm',
    version: '0.2.0',
  });

  // Register MCP App HTML resource
  server.registerResource(
    'AGY Ext Swarm Board UI',
    APP_RESOURCE_URI,
    {
      description: 'Live side-pane dashboard for AGY Ext Swarm board, topology replay, workers, and usage.',
      mimeType: APP_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: APP_MIME_TYPE,
          text: loadBoardHtml(pluginRoot),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  const ctx: ToolContext = { server, store, runtime, dataDir, brainDir };
  registerModelTools(ctx);
  registerAppTools(ctx);

  const onShutdown = () => {
    runtime.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[agy-ext-swarm] MCP server listening on stdio (dataDir=${dataDir})`);
}

main().catch((err) => {
  console.error('[agy-ext-swarm] Fatal error:', err);
  process.exit(1);
});
