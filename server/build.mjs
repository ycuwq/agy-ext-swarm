import { build } from 'esbuild';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(rootDir, 'dist');
mkdirSync(distDir, { recursive: true });

// 1. Bundle MCP server ESM entrypoint & providers module (for unit testing)
await build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  outfile: join(distDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});

await build({
  entryPoints: [join(rootDir, 'src', 'providers', 'index.ts')],
  outfile: join(distDir, 'providers.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
});

// 2. Bundle MCP App UI into single self-contained HTML
const uiResult = await build({
  entryPoints: [join(rootDir, 'ui', 'app.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: true,
});

const jsBundle = uiResult.outputFiles[0].text;
const cssRaw = readFileSync(join(rootDir, 'ui', 'styles.css'), 'utf8');
const htmlTemplate = readFileSync(join(rootDir, 'ui', 'index.html'), 'utf8');

const finalHtml = htmlTemplate
  .replace('/*__INLINE_CSS__*/', () => cssRaw)
  .replace('/*__INLINE_JS__*/', () => jsBundle);

const outHtmlPath = join(distDir, 'board.html');
writeFileSync(outHtmlPath, finalHtml, 'utf8');

const serverBytes = statSync(join(distDir, 'index.mjs')).size;
const htmlBytes = statSync(outHtmlPath).size;
console.log(`Built dist/index.mjs (${serverBytes} bytes) and dist/board.html (${htmlBytes} bytes)`);
if (htmlBytes > 1024 * 1024) {
  throw new Error(`dist/board.html exceeds 1 MiB (${htmlBytes} bytes)`);
}
