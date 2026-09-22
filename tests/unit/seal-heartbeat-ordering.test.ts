import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sealProgressWriter } from '../../src/workflow/orchestrator.js';

/**
 * The seal heartbeat ends with `seal_complete`, and the seal's own e2e asserts that the **last** line is it.
 *
 * That assertion failed inside a real seal while passing standalone — and the cause was not the assertion. Every
 * progress event was appended with a fire-and-forget `void write(...)`, so a line emitted just before `finish()` could
 * still be in flight when `seal_complete` was written, and the two appends could land in either order. `finish()`
 * awaited only its own write, so it did not close that window.
 *
 * The contract this pins: **`finish()` does not resolve until every line emitted before it is durable, and
 * `seal_complete` is the last of them.** The delay below is what makes it deterministic — under the old writer the slow
 * first append lands after `seal_complete`, so the property fails every time rather than one time in a hundred.
 */
describe('seal heartbeat ordering', () => {
    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('writes seal_complete last even when an earlier line is slow to land', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-heartbeat-'));
        roots.push(root);

        const landed: string[] = [];
        const writer = await sealProgressWriter(root, 'heartbeat', async (line) => {
            // The first line is slow; the seal's completion is not. Ordering must not depend on which wins the race.
            if (line.type === 'quality_check_progress') await new Promise((resolve) => setTimeout(resolve, 30));
            landed.push(String(line.type));
        });

        writer({ type: 'quality_check_progress', check: 'linty', state: 'started', timeoutMs: 10_000 });
        writer({ type: 'quality_check_progress', check: 'linty', state: 'passed', exitCode: 0, timeoutMs: 10_000 });
        await writer.finish();

        expect(landed.at(-1)).toBe('seal_complete');
        expect(landed.filter((type) => type === 'quality_check_progress')).toHaveLength(2);
    });

    it('keeps the heartbeat an observation: a failing append never fails the seal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-heartbeat-throw-'));
        roots.push(root);

        const writer = await sealProgressWriter(root, 'heartbeat', async () => {
            throw new Error('disk full');
        });

        writer({ type: 'quality_check_progress', check: 'linty', state: 'started', timeoutMs: 10_000 });
        await expect(writer.finish()).resolves.toBeUndefined();
    });
});
