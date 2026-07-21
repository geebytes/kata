import { defineConfig } from 'vitest/config';

// vitest-side mirror of scripts/build.mjs's kata-asset plugin.
// `kata-asset:<rel-path>` imports resolve to the file's raw content via
// Vite's built-in `?raw` suffix, which returns the file as a string default
// export. The build-time esbuild plugin does the same thing in production.
const kataAssetPlugin = {
  name: 'kata-asset-resolver',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (!source.startsWith('kata-asset:')) return null;
    const rel = source.replace(/^kata-asset:/, '');
    // Resolve relative to project root, then append ?raw so Vite serves the
    // file's contents as a string (its default export).
    return `${rel}?raw`;
  },
};

export default defineConfig({
  plugins: [kataAssetPlugin],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
