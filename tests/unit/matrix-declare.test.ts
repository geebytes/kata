import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { runMatrixCommand } from '../../src/cli/matrix.js';

/**
 * The other half of the declaration-correction capability, and what it unblocks.
 *
 * Measured: `major-finding-closure` and `repair-obligation-deadlock` both report `judge PASS`, `verify PASS`, zero failing
 * evidence and zero obligations — and `archive` refuses them for `missingAcceptanceMatrix`, a field the status payload
 * carries while neither the ladder nor the refusal message names it. Rows were declarable only at `open --bootstrap-file`,
 * so a task created before that had no way to acquire one.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kata-matrix-declare-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/x.ts'],
        acceptance: [{ id: 'AC-1', statement: 'the check gates' }],
    } as never);
    return root;
}

const matrix = {
    version: 1,
    rows: [
        {
            acceptanceId: 'AC-1',
            implementationPaths: ['src/x.ts'],
            testPaths: ['tests/unit/x.test.ts'],
            evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/x.test.ts' }],
            verificationLevel: 'unit',
        },
    ],
};

describe('a task can acquire the matrix it needs to be archivable', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('declares one, and refuses a second or an invalid one', async () => {
        const root = await fixture('declare');
        await writeFile(join(root, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');

        const declared = await runMatrixCommand(['declare', '--change', 'declare', '--from-file', 'matrix.json', '--reason', 'the task predates matrices'], root);
        expect(declared.updated).toBe(true);
        expect(declared.rows).toBe(1);
        const task = await readTask(root, 'declare');
        expect(task.acceptanceMatrix?.rows).toHaveLength(1);

        // A second declaration would discard the first silently.
        const again = await runMatrixCommand(['declare', '--change', 'declare', '--from-file', 'matrix.json', '--reason', 'again'], root);
        expect(again.updated).toBe(false);
        expect(again.error).toMatch(/already declares a matrix/);

        // And a row referencing a criterion nobody declared is refused before anything is written.
        const other = await fixture('declare-invalid');
        await writeFile(join(other, 'matrix.json'), `${JSON.stringify({ ...matrix, rows: [{ ...matrix.rows[0], acceptanceId: 'AC-9' }] }, null, 2)}\n`, 'utf8');
        const invalid = await runMatrixCommand(['declare', '--change', 'declare-invalid', '--from-file', 'matrix.json', '--reason', 'bad'], other);
        expect(invalid.updated).toBe(false);
        expect(invalid.error).toMatch(/does not validate/);
        expect((await readTask(other, 'declare-invalid')).acceptanceMatrix).toBeUndefined();
    });
});

/**
 * AC-4's second half: routing a finding closes the obligation it produced.
 *
 * Until this existed, a routed finding left its obligation open forever. Obligations close on **evidence** — a seal
 * producing fresh passing results — and a finding handed to another change will never be repaired here, so no seal in this
 * change could ever close it. That is the loop `wiring-coverage-check` measured: six obligations whose findings are all
 * routed, and no honest way to close them.
 */
describe('a routed finding closes its obligation, and the closure says where it went', () => {
    it('records the carrier rather than claiming a repair', async () => {
        const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-rout-obligation-'));
        try {
            const { initLayout } = await import('../../src/core/layout.js');
            const { createTask } = await import('../../src/core/task.js');
            const { persistBlockingFindings, readObligations, resolveObligationsForRouting } = await import('../../src/quality/repair-obligations.js');
            await initLayout(root);
            await mkdir(join(root, 'src'), { recursive: true });
            await createTask({ root, id: 'rout-obligation', title: 'rout-obligation', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);

            await persistBlockingFindings(root, 'rout-obligation', [
                { id: 'f-routed', severity: 'major', message: 'repair lives elsewhere' },
            ]);
            const before = await readObligations(root, 'rout-obligation');
            expect(before.filter((obligation) => !obligation.resolvedAt)).toHaveLength(1);

            const closed = await resolveObligationsForRouting(root, 'rout-obligation', 'f-routed', 'kata-gate-surface', 'the gate derivation lives there');
            expect(closed).toBe(1);

            const after = await readObligations(root, 'rout-obligation');
            const obligation = after.find((entry) => entry.findingId === 'f-routed');
            expect(obligation?.resolvedAt).toBeTruthy();
            // The distinction the closure has to keep: handed over, not repaired.
            expect(obligation?.resolvedByRouting).toEqual({ to: 'kata-gate-surface', reason: 'the gate derivation lives there' });
            expect(obligation?.resolvedByRevisionId).toBeUndefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 60000);
});
