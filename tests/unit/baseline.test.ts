import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineReadPaths, measureRequiredReads, runBaselineCommand, summarizePayload } from '../../src/cli/baseline.js';

/**
 * L0-03: compaction must be justified by a number, so the number has to be produced the same way twice.
 *
 * The report is deliberately boring: exact bytes, a labelled token estimate, and the authoritative reads with their
 * sizes. What it must never do is quietly omit a read it could not find — a missing read still costs the agent a
 * failed lookup.
 */
describe('payload baseline', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('counts bytes exactly and calls the token count an estimate', () => {
        const measurement = summarizePayload('kata-build', 'a\nb\n');

        expect(measurement).toMatchObject({ target: 'kata-build', bytes: 4, lines: 3 });
        expect(measurement.estimatedTokens).toBe(1); // 4 characters / 4, rounded up — an estimate, not a bill
    });

    it('lists a required read that does not exist instead of dropping it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-baseline-'));
        roots.push(root);
        await writeFile(join(root, 'AGENTS.md'), '# agents\n', 'utf8');

        const measured = await measureRequiredReads(root, ['AGENTS.md', '.llmwiki/SCHEMA.md']);

        expect(measured).toEqual([
            { path: 'AGENTS.md', bytes: 9, present: true },
            { path: '.llmwiki/SCHEMA.md', bytes: 0, present: false },
        ]);
    });

    it('measures every generated skill and states the estimate it used', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-baseline-full-'));
        roots.push(root);
        await mkdir(join(root, '.llmwiki'), { recursive: true });

        const report = await runBaselineCommand(['--platform', 'pi', '--language', 'en', '--root', root]);

        expect(report.skills).toHaveLength(12);
        expect(report.skillsTotalBytes).toBeGreaterThan(0);
        expect(report.skillsTotalEstimatedTokens).toBeGreaterThan(0);
        // Every measured skill reports a byte count that is not an estimate.
        expect(report.skills.every((skill) => skill.bytes > 0)).toBe(true);
    });

    it('adds the task-scoped reads only when a change id was given', () => {
        expect(baselineReadPaths()).toHaveLength(5);
        expect(baselineReadPaths('kata-x1')).toHaveLength(7);
        expect(baselineReadPaths('kata-x1').at(-1)).toBe('.kata/tasks/kata-x1/current-state.json');
    });
});
