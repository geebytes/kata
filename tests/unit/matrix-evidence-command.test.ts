import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { runMatrixCommand } from '../../src/cli/matrix.js';

/**
 * A sealed task's acceptance matrix could only be declared through `open --bootstrap-file`, which exists at creation and
 * never again. Measured consequence: two criteria declared the same `testSelector`, the seal emitted one evidence file
 * (dedup by selector is correct), one criterion ended up unreferenced, and verify failed `insufficient_evidence_level`
 * with no supported way to correct the declaration — the only remaining option was hand-editing `task.json`, which is the
 * unverifiable-write pattern this whole change exists to remove.
 */
describe('a matrix declaration can be corrected through the CLI, with validation', () => {
    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function taskWithSharedSelector(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-matrix-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root, id: 'm', title: 'M',
            acceptance: [
                { id: 'AC-1', statement: 'first' },
                { id: 'AC-2', statement: 'second' },
            ],
            acceptanceMatrix: {
                version: 1,
                rows: [
                    { acceptanceId: 'AC-1', implementationPaths: ['src/a.ts'], testPaths: ['tests/unit/a.test.ts'], evidence: [{ id: 'e1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/a.test.ts' }], verificationLevel: 'unit' },
                    { acceptanceId: 'AC-2', implementationPaths: ['src/b.ts'], testPaths: ['tests/unit/b.test.ts'], evidence: [{ id: 'e2', kind: 'test', command: 'vitest', testSelector: 'tests/unit/a.test.ts' }], verificationLevel: 'unit' },
                ],
            },
        } as never);
        return root;
    }

    it('corrects a criterion\'s evidence selector and persists it', async () => {
        const root = await taskWithSharedSelector();
        const result = await runMatrixCommand(['set', '--change', 'm', '--acceptance', 'AC-2', '--selector', 'tests/unit/b.test.ts', '--reason', 'AC-2 declared AC-1\'s selector by mistake'], root);

        expect(result.updated).toBe(true);
        const task = await readTask(root, 'm');
        const row = task?.acceptanceMatrix?.rows.find((entry) => entry.acceptanceId === 'AC-2');
        expect(row?.evidence?.[0]?.testSelector).toBe('tests/unit/b.test.ts');
    });

    it('refuses a correction that would make another criterion share the selector', async () => {
        // The defect was a declaration that could not say which evidence answers which criterion. A correction must not
        // reproduce it, so the command validates against the declaration as a whole rather than just writing a value.
        const root = await taskWithSharedSelector();
        const result = await runMatrixCommand(['set', '--change', 'm', '--acceptance', 'AC-2', '--selector', 'tests/unit/a.test.ts', '--reason', 'no-op'], root);

        expect(result.updated).toBe(false);
        expect(String(result.error)).toMatch(/AC-1|shared|declared by/i);
    });

    it('refuses an unknown acceptance criterion instead of writing an orphan row', async () => {
        const root = await taskWithSharedSelector();
        const result = await runMatrixCommand(['set', '--change', 'm', '--acceptance', 'AC-9', '--selector', 'tests/unit/z.test.ts', '--reason', 'typo'], root);

        expect(result.updated).toBe(false);
        expect(String(result.error)).toMatch(/AC-9/);
    });

    it('requires a reason, because a corrected declaration is a decision', async () => {
        const root = await taskWithSharedSelector();
        const result = await runMatrixCommand(['set', '--change', 'm', '--acceptance', 'AC-2', '--selector', 'tests/unit/b.test.ts'], root);

        expect(result.updated).toBe(false);
        expect(String(result.error)).toMatch(/reason/i);
    });
});
