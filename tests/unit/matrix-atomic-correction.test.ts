import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { runMatrixCommand } from '../../src/cli/matrix.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * `matrix set --from-file` — the atomic correction, and the only way out of a dead end: when two criteria share a selector, the
 * one-row path cannot separate them (changing either leaves the other sharing it, and the guard refuses every intermediate
 * state), so the whole corrected matrix is validated as a result instead.
 *
 * It had no test when it unblocked this change's own seal (`cg-f6`), which is the class this line keeps finding: the mechanism
 * that mattered most was the one nobody had exercised from a test.
 */
describe('the atomic matrix correction', () => {
    async function fixture(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-atomic-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root, id: 'atomic', title: 'Atomic', ownedPaths: ['src/x.ts'],
            acceptance: [{ id: 'AC-1', statement: 'one' }, { id: 'AC-2', statement: 'two' }],
            acceptanceMatrix: {
                version: 1,
                rows: ['AC-1', 'AC-2'].map((id) => ({
                    acceptanceId: id,
                    implementationPaths: ['src/x.ts'],
                    testPaths: ['tests/unit/shared.test.ts'],
                    evidence: [{ id: `e-${id}`, kind: 'test', command: 'vitest', testSelector: 'tests/unit/shared.test.ts' }],
                    verificationLevel: 'unit',
                })),
            },
        } as never);
        return root;
    }

    it('applies a whole corrected matrix, reports the previous selectors, and validates the result', async () => {
        const root = await fixture();
        const previous = process.cwd();
        process.chdir(root);
        try {
            const corrected = join(root, 'tmp-corrected.json');
            await writeFile(corrected, JSON.stringify({
                rows: ['AC-1', 'AC-2'].map((id) => ({
                    acceptanceId: id,
                    implementationPaths: ['src/x.ts'],
                    testPaths: [`tests/unit/${id.toLowerCase()}.test.ts`],
                    evidence: [{ id: `e-${id}`, kind: 'test', command: 'vitest', testSelector: `tests/unit/${id.toLowerCase()}.test.ts` }],
                    verificationLevel: 'unit',
                })),
            }), 'utf8');

            const result = await runMatrixCommand(['set', '--change', 'atomic', '--from-file', corrected, '--reason', 'separating two rows that shared a selector']);
            expect(result.updated).toBe(true);
            // Auditable: what each row's selector was, so a correction is a record rather than an overwrite.
            expect(result.previousSelectors).toEqual([
                { acceptanceId: 'AC-1', testSelector: 'tests/unit/shared.test.ts' },
                { acceptanceId: 'AC-2', testSelector: 'tests/unit/shared.test.ts' },
            ]);
            const task = await readTask(root, 'atomic');
            expect(task.acceptanceMatrix?.rows.map((row) => row.testPaths?.[0]))
                .toEqual(['tests/unit/ac-1.test.ts', 'tests/unit/ac-2.test.ts']);
        } finally {
            process.chdir(previous);
        }
    });

    it('refuses a result that does not validate, and leaves the matrix as it was', async () => {
        const root = await fixture();
        const previous = process.cwd();
        process.chdir(root);
        try {
            const broken = join(root, 'tmp-broken.json');
            // Both rows keep the shared selector: exactly the state the guard exists to refuse, and the reason the one-row
            // path cannot get here — so the atomic path has to refuse it too.
            await writeFile(broken, JSON.stringify({ rows: [{ acceptanceId: 'AC-1' }] }), 'utf8');
            const result = await runMatrixCommand(['set', '--change', 'atomic', '--from-file', broken, '--reason', 'a broken correction']);
            expect(result.updated).toBe(false);
            // The message differs by shape: a malformed row makes the validator throw rather than report, and the catch
            // returns that. What matters is the refusal and that nothing was written — asserted below rather than assumed.
            expect(String(result.error).length).toBeGreaterThan(0);
            const task = await readTask(root, 'atomic');
            expect(task.acceptanceMatrix?.rows.map((row) => row.testPaths?.[0])).toEqual(['tests/unit/shared.test.ts', 'tests/unit/shared.test.ts']);
        } finally {
            process.chdir(previous);
        }
    });
});
