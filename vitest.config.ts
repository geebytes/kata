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
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * **A stated liveness bound, because the default is not a budget.**
     *
     * Vitest's default is 5 s per case, and parts of this suite spawn subprocesses: the installer cases drive
     * `kata-cli update`, which runs the runtime refresh (Comet, then CodeGraph sync and index). Measured, one of those
     * cases takes **3.6 s** on an idle machine and **5.0 s** while the seal's sandbox is running its other checks — so a
     * default that is 28 % above idle cost made the case a coin flip, and it failed inside a seal as
     * `Test timed out in 5000ms` while passing in the working tree.
     *
     * A timeout is not an assertion: it bounds liveness, and raising it cannot make a wrong answer look right. What it
     * does cost is time-to-failure for a case that really hangs — stated here rather than discovered in a seal.
     */
    testTimeout: 30_000,
  },
});
