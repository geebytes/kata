import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCometProject } from '../../src/comet/install.js';
import { loadCometCompatibility } from '../../src/comet/compat.js';

// These tests run against the real comet binary (present in the dev container).
// They verify the multi-platform contract introduced for the STRATA wizard:
// one non-interactive comet init per selected platform, merged into one report.

describe('initCometProject multi-platform loop (real comet)', () => {
    it('runs one headless comet init per selected platform and merges results', async () => {
        const home = await mkdtemp(join(tmpdir(), 'comet-loop-'));
        const previousHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const compat = loadCometCompatibility();
            const result = await initCometProject({
                root: home,
                scope: 'global',
                language: 'en',
                yes: true,
                platforms: ['codex', 'opencode'],
                extras: { workflow: 'native' },
                compat,
                cometVersion: '0.4.0-beta.14',
            });
            expect(result.status).toBe('initialized');
            expect(result.platforms).toEqual(['codex', 'opencode']);
        } finally {
            process.env.HOME = previousHome;
            await rm(home, { recursive: true, force: true });
        }
    }, 30000);

    it('runs a single comet init when no platforms are given', async () => {
        const home = await mkdtemp(join(tmpdir(), 'comet-single-'));
        const previousHome = process.env.HOME;
        process.env.HOME = home;
        try {
            const compat = loadCometCompatibility();
            const result = await initCometProject({
                root: home,
                scope: 'global',
                language: 'en',
                yes: true,
                platforms: [],
                extras: { workflow: 'native' },
                compat,
                cometVersion: '0.4.0-beta.14',
            });
            expect(result.status).toBe('initialized');
            expect(result.platforms).toBeUndefined();
        } finally {
            process.env.HOME = previousHome;
            await rm(home, { recursive: true, force: true });
        }
    }, 30000);
});
