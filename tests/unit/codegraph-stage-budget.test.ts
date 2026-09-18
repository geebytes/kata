import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRuntimeRefresh } from '../../src/cli/installer.js';

/**
 * The CodeGraph stages do not share one budget (found 2026-09-18).
 *
 * `kata-cli update --force` reported `CodeGraph index 超时` on every run. The budget was a fixed 30_000ms, and
 * `codegraph index` is a **full rebuild**: measured at 35–46s on this repository (972 indexed files — `.models/` is
 * git-ignored and not indexed, so the size of the checkout is not the issue). So the stage timed out on a healthy
 * project, every time, which is a failure that says nothing and teaches the reader to ignore the line that would matter.
 *
 * `sync` is incremental and finishes in under a second. The two stages therefore get different budgets, and the stage
 * record says which budget it had — so a timeout can be read as "this took longer than its budget" rather than as
 * "something is wrong with your project".
 */
describe('CodeGraph stage budgets', () => {
    const roots: string[] = [];
    let previousRefresh: string | undefined;

    beforeEach(() => {
        previousRefresh = process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS;
        // A deliberately tiny refresh budget: `sync` must honour it…
        process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS = '1000';
    });

    afterEach(async () => {
        if (previousRefresh === undefined) delete process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS;
        else process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS = previousRefresh;
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function fakeCodegraph(sleepMs: number): Promise<{ root: string; binary: string }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-codegraph-budget-'));
        roots.push(root);
        const binary = join(root, 'codegraph');
        await writeFile(binary, `#!/bin/sh\nsleep ${sleepMs}\nexit 0\n`, { mode: 0o755 });
        return { root, binary };
    }

    it('gives index its own budget instead of the refresh budget that suits sync', async () => {
        const { root, binary } = await fakeCodegraph(3);
        const previousBinary = process.env.STRATA_CODEGRAPH_BIN;
        process.env.STRATA_CODEGRAPH_BIN = binary;
        process.env.KATA_CODEGRAPH_INDEX_TIMEOUT_MS = '20000';
        try {
            const refresh = await runRuntimeRefresh(root);
            const stages = new Map(refresh.stages.map((stage) => [stage.stage, stage]));

            // `sync` took 3s against a 1s refresh budget: cut off, and reported with the budget it had.
            expect(stages.get('codegraph-sync')).toMatchObject({ status: 'timed_out', timeoutMs: 1000 });
            // `index` took the same 3s against its own budget: it completed, and says which budget that was.
            expect(stages.get('codegraph-index')).toMatchObject({ status: 'completed', timeoutMs: 20000 });
        } finally {
            if (previousBinary === undefined) delete process.env.STRATA_CODEGRAPH_BIN;
            else process.env.STRATA_CODEGRAPH_BIN = previousBinary;
            delete process.env.KATA_CODEGRAPH_INDEX_TIMEOUT_MS;
        }
    }, 30_000);

    it('defaults the index budget to a full rebuild rather than a sync', async () => {
        const { root, binary } = await fakeCodegraph(0);
        const previousBinary = process.env.STRATA_CODEGRAPH_BIN;
        process.env.STRATA_CODEGRAPH_BIN = binary;
        try {
            const refresh = await runRuntimeRefresh(root);
            const index = refresh.stages.find((stage) => stage.stage === 'codegraph-index');
            // 35–46s measured; the default must comfortably exceed it, and exceed the refresh budget it used to share.
            expect(index?.timeoutMs).toBeGreaterThanOrEqual(300_000);
            expect(index?.timeoutMs).toBeGreaterThan(Number(process.env.KATA_RUNTIME_REFRESH_TIMEOUT_MS));
        } finally {
            if (previousBinary === undefined) delete process.env.STRATA_CODEGRAPH_BIN;
            else process.env.STRATA_CODEGRAPH_BIN = previousBinary;
        }
    });
});
