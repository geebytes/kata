#!/usr/bin/env node
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Plugin: inline project assets (schemas/*.json, comet-compat.yaml) as
// string constants so the published bundle has zero external file deps.
// This is what makes `npm install -g <git-url>` robust — even if pacote's
// hosted-git path lands only a subset of files, the single cli.js works.
const assetPlugin = {
  name: 'kata-asset',
  setup(build) {
    const assetRoot = resolve(root);
    build.onResolve({ filter: /^kata-asset:/ }, (args) => {
      const rel = args.path.replace(/^kata-asset:/, '');
      return { path: resolve(assetRoot, rel), namespace: 'kata-asset' };
    });
    build.onLoad({ filter: /.*/, namespace: 'kata-asset' }, (args) => {
      const content = readFileSync(args.path, 'utf8');
      return {
        contents: `export default ${JSON.stringify(content)};`,
        loader: 'js',
      };
    });
  },
};

const outfile = resolve(root, 'dist/cli.js');

await esbuild.build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [assetPlugin],
  // Keep node_modules dependencies as external imports — only inline our own
  // source + assets. This avoids ESM/CJS interop wrapping (`Dynamic require`
  // errors) and keeps the bundle small while still producing a single self-
  // contained cli.js for our own code.
  packages: 'external',
});

chmodSync(outfile, 0o755);

console.log('build: dist/cli.js (single-file bundle)');
