#!/usr/bin/env node
// `npm run check:wiring` — the three mechanical checks, as one command.
//
// The checks live in TypeScript with `.js` import specifiers, which bare `node` cannot resolve, so this wrapper bundles
// them with the same esbuild the project already uses for `dist/cli.js`. Running the *source* rather than the published
// bundle is deliberate: a check that reads the repository should not depend on the repository having been built first.
//
// Usage:
//   npm run check:wiring                                  # reference + declared-member over src/ and tests/
//   node scripts/wiring-check.mjs --checks mutation \
//        --mutation-command npx vitest run --surface src/quality/adversarial.ts
//
// Exit codes: 0 clean · 1 findings · 2 the instrument could not run.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

const argv = process.argv.slice(2);
const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
};
const listAfter = (flag) => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const values = [];
    for (let i = index + 1; i < argv.length && !argv[i].startsWith('--'); i++) values.push(argv[i]);
    return values;
};

const workspace = await mkdtemp(join(tmpdir(), 'kata-wiring-check-'));
const bundled = join(workspace, 'wiring-check.mjs');
try {
    const built = await esbuild.build({
        entryPoints: [resolve(here, '..', 'src', 'quality', 'wiring-check.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        packages: 'external',
        write: false,
        logLevel: 'error',
    });
    await writeFile(bundled, built.outputFiles[0].text, 'utf8');

    const module = await import(pathToFileURL(bundled).href);
    const checks = listAfter('--checks');
    const mutationCommand = listAfter('--mutation-command');

    const exitCode = await module.runWiringCheckCommand({
        root,
        ...(listAfter('--surface') ? { surface: listAfter('--surface') } : {}),
        ...(checks ? { checks } : {}),
        ...(mutationCommand
            ? {
                mutation: {
                    scratch: valueOf('--mutation-scratch') ?? join(root, 'tmp', 'wiring-check-scratch'),
                    command: mutationCommand[0],
                    args: mutationCommand.slice(1),
                },
            }
            : {}),
    });
    process.exitCode = exitCode;
} finally {
    await rm(workspace, { recursive: true, force: true });
}
