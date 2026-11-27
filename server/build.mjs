import { build, transform } from 'esbuild';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(rootDir, 'dist');
mkdirSync(distDir, { recursive: true });
const serverPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

const ESM_CREATE_REQUIRE_BANNER =
  "import { createRequire as __agyExtSwarmCreateRequire } from 'node:module'; const require = __agyExtSwarmCreateRequire(import.meta.url);";

function assertOnlyBuiltinExternals(result, label) {
  const outputs = result.metafile?.outputs ?? {};
  const disallowed = [];
  for (const [outFile, meta] of Object.entries(outputs)) {
    for (const imp of meta.imports ?? []) {
      if (imp.external && !NODE_BUILTINS.has(imp.path)) {
        disallowed.push(`${outFile} -> ${imp.path}`);
      }
    }
  }
  if (disallowed.length > 0) {
    throw new Error(
      `[build] ${label} has non-builtin external imports:\n  ${disallowed.join('\n  ')}`,
    );
  }
}

// 1. Bundle MCP server ESM entrypoint & providers module (zero external npm deps at runtime)
const indexResult = await build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  outfile: join(distDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  sourcemap: true,
  metafile: true,
  define: {
    __AGY_EXT_SWARM_VERSION__: JSON.stringify(serverPkg.version || '0.0.0'),
  },
  banner: {
    js: ESM_CREATE_REQUIRE_BANNER,
  },
});
assertOnlyBuiltinExternals(indexResult, 'dist/index.mjs');

const providersResult = await build({
  entryPoints: [join(rootDir, 'src', 'providers', 'index.ts')],
  outfile: join(distDir, 'providers.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  metafile: true,
  banner: {
    js: ESM_CREATE_REQUIRE_BANNER,
  },
});
assertOnlyBuiltinExternals(providersResult, 'dist/providers.mjs');

const hostTelemetryResult = await build({
  entryPoints: [join(rootDir, 'src', 'host', 'index.ts')],
  outfile: join(distDir, 'host-telemetry.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  metafile: true,
  banner: {
    js: ESM_CREATE_REQUIRE_BANNER,
  },
});
assertOnlyBuiltinExternals(hostTelemetryResult, 'dist/host-telemetry.mjs');

// 2. Bundle MCP App UI into single self-contained HTML
let uiZod4Root;
try {
  const rootReq = createRequire(import.meta.url);
  const extAppsPath = rootReq.resolve('@modelcontextprotocol/ext-apps');
  const clientPath = createRequire(extAppsPath).resolve('@modelcontextprotocol/client');
  const candidate = dirname(createRequire(clientPath).resolve('zod/v4'));
  if (!existsSync(join(candidate, 'index.js'))) {
    throw new Error('zod/v4 ESM entry is missing from ' + candidate);
  }
  uiZod4Root = candidate;
} catch (err) {
  console.warn('[build] Could not resolve the UI zod/v4 package root. Using esbuild resolution.', err.message);
}

const uiZodDedupePlugin = {
  name: 'dedupe-zod-v4-and-trim-locales',
  setup(b) {
    if (uiZod4Root) {
      b.onResolve({ filter: /^zod\/v4(\/.*)?$/ }, ({ path }) => {
        const subpath = path.split('/').slice(2);
        return b.resolve(join(uiZod4Root, ...subpath), {
          kind: 'import-statement',
          resolveDir: uiZod4Root,
        });
      });
    }
    b.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/ }, ({ path }) => {
      const hasZhCN = existsSync(join(dirname(path), 'zh-CN.js'));
      return {
        contents: 'export { default as en } from "./en.js";' +
          (hasZhCN ? '\nexport { default as zhCN } from "./zh-CN.js";' : ''),
        loader: 'js',
        resolveDir: dirname(path),
      };
    });
  },
};

const uiResult = await build({
  entryPoints: [join(rootDir, 'ui', 'app.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: true,
  legalComments: 'none',
  plugins: [uiZodDedupePlugin],
  define: {
    __AGY_EXT_SWARM_VERSION__: JSON.stringify(serverPkg.version || '0.0.0'),
  },
});

const jsBundle = uiResult.outputFiles[0].text;
const cssRaw = readFileSync(join(rootDir, 'ui', 'styles.css'), 'utf8');
const cssMin = (await transform(cssRaw, { loader: 'css', minify: true })).code;
assert(!/<\/script/i.test(jsBundle), '[build] Inline JavaScript contains a closing script tag.');
assert(!/<\/style/i.test(cssMin), '[build] Inline CSS contains a closing style tag.');
const htmlRaw = readFileSync(join(rootDir, 'ui', 'index.html'), 'utf8');
const htmlTemplate = htmlRaw
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/>\s+</g, '><')
  .replace(/\s*\n\s*/g, ' ')
  .replace(/\s+>/g, '>')
  .trim();

const finalHtml = htmlTemplate
  .replace('/*__INLINE_CSS__*/', () => cssMin)
  .replace('/*__INLINE_JS__*/', () => jsBundle);

const outHtmlPath = join(distDir, 'board.html');
writeFileSync(outHtmlPath, finalHtml, 'utf8');

const serverBytes = statSync(join(distDir, 'index.mjs')).size;
const providersBytes = statSync(join(distDir, 'providers.mjs')).size;
const hostBytes = statSync(join(distDir, 'host-telemetry.mjs')).size;
const htmlBytes = statSync(outHtmlPath).size;
console.log(
  `Built dist/index.mjs (${serverBytes} bytes), dist/providers.mjs (${providersBytes} bytes), dist/host-telemetry.mjs (${hostBytes} bytes), and dist/board.html (${htmlBytes} bytes)`,
);
if (htmlBytes > 1024 * 1024) {
  throw new Error(`dist/board.html exceeds 1 MiB (${htmlBytes} bytes)`);
}
