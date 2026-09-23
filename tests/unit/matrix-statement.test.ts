import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { runMatrixCommand } from '../../src/cli/matrix.js';

/**
 * The statement half of the declaration-correction capability.
 *
 * Measured on `wiring-coverage-check`: AC-2 claimed the check "finds the 24 dead exported symbols measured on 2026-09-22"
 * and AC-4 that a test asserts "the 15 guards measured to be removable" — both numbers withdrawn, so no test could satisfy
 * either criterion without asserting a falsehood, and there was no governed way to say so. Hand-editing `task.json` is the
 * unverifiable write this platform exists to remove.
 *
 * The correction is guarded rather than free: a reason is required, the previous text is kept, and the ids are untouched.
 * The previous text is kept **beside** the task — the acceptance item is `additionalProperties: false` over
 * `id`/`statement`/`claims`, so a history field there would make the task unreadable. That was checked before this was
 * written, not discovered after.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kata-matrix-statement-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/x.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the check finds the 24 dead exported symbols' }],
    } as never);
    return root;
}

describe('an acceptance statement can be corrected through a governed path', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('corrects it, keeps the previous text, and leaves the task readable', async () => {
        const root = await fixture('statement');
        const result = await runMatrixCommand(
            ['set', '--change', 'statement', '--acceptance', 'AC-1', '--statement', 'the check reports the dead set and spares what production calls', '--reason', 'the 24th was a false positive, withdrawn'],
            root,
        );

        expect(result.updated).toBe(true);
        expect(result.previous).toBe('the check finds the 24 dead exported symbols');

        // The task must still be readable: a correction that made it schema-invalid would be corruption, not a feature.
        const task = await readTask(root, 'statement');
        expect(task.acceptance?.[0]?.statement).toBe('the check reports the dead set and spares what production calls');

        // And the previous text survives beside the task, because the acceptance item cannot carry a history.
        const corrections = JSON.parse(await readFile(join(root, '.kata/tasks/statement/declaration-corrections.json'), 'utf8')) as Array<{
            acceptanceId?: string;
            previous?: string;
            reason?: string;
        }>;
        expect(corrections).toHaveLength(1);
        expect(corrections[0]).toMatchObject({ acceptanceId: 'AC-1', previous: 'the check finds the 24 dead exported symbols' });
        expect(corrections[0]?.reason).toContain('false positive');
    });

    it('refuses a correction with no reason, and one that changes nothing', async () => {
        const root = await fixture('statement-refusals');
        const noReason = await runMatrixCommand(['set', '--change', 'statement-refusals', '--acceptance', 'AC-1', '--statement', 'anything'], root);
        expect(noReason.updated).toBe(false);
        expect(noReason.error).toMatch(/requires --reason/);

        const unchanged = await runMatrixCommand(
            ['set', '--change', 'statement-refusals', '--acceptance', 'AC-1', '--statement', 'the check finds the 24 dead exported symbols', '--reason', 'noop'],
            root,
        );
        expect(unchanged.updated).toBe(false);
        expect(unchanged.error).toMatch(/already the declared one/);
    });
});

/**
 * The third variant of the same gap, surfaced as a minor finding on this change's own matrix: AC-1's row declared
 * `src/quality/change-surface.ts` as an implementation path — a file that does not exist, because the derivation lives in
 * `adversarial.ts` — and the brief's reading set then named it, telling a reviewer to start with a file that is not there.
 */
describe('an implementation path can be corrected through the same governed path', () => {
    it('corrects the row, and the correction validates', async () => {
        const root = await fixture('impl-path');
        const { mutateTaskArtefact } = await import('../../src/core/state.js');
        const { taskPath } = await import('../../src/core/layout.js');
        // Give the task a matrix whose row names a path, so the correction has something to change.
        await mutateTaskArtefact(root, 'impl-path', taskPath(root, 'impl-path'), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({
                ...current,
                acceptanceMatrix: {
                    version: 1,
                    rows: [
                        {
                            acceptanceId: 'AC-1',
                            implementationPaths: ['src/quality/change-surface.ts'],
                            testPaths: ['tests/unit/x.test.ts'],
                            evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/x.test.ts' }],
                            verificationLevel: 'unit',
                        },
                    ],
                },
            }, null, 2)}\n`;
        });

        const result = await runMatrixCommand(
            ['set', '--change', 'impl-path', '--acceptance', 'AC-1', '--implementation-path', 'src/quality/adversarial.ts', '--reason', 'the derivation lives there, not in a file that was never created'],
            root,
        );
        expect(result.updated).toBe(true);
        expect(result.previousPaths).toEqual(['src/quality/change-surface.ts']);

        const task = await readTask(root, 'impl-path');
        expect(task.acceptanceMatrix?.rows[0]?.implementationPaths).toEqual(['src/quality/adversarial.ts']);
    });
});
