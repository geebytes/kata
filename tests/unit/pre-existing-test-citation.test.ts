import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

/**
 * `kgs-f9`'s falsifier, fourth attempt — and the two prerequisites the first three missed are both structural:
 *
 *  - `permittedTests` is `declaredTestSelectors ∪ sealedRevisionTestSelectors`, and the check is **skipped entirely** when
 *    that union is empty. A fixture with no acceptance matrix declares no selector, so the check never runs and an
 *    assertion about its refusal passes in both versions;
 *  - the sealed-revision half is only supplied when the sealed **change record** is for this revision, so without one the
 *    mutation has nothing to change.
 *
 * With both in place the case is the finding's own: a pass citing a test the sealed revision **carried but did not change**
 * must not be refused as undeclared, and reverting the fix must refuse it.
 */
const cleanup: string[] = [];

async function fixture(id: string): Promise<{ root: string; base: string; current: string }> {
    const root = await mkdtemp(join(tmpdir(), `kata-citation-${id}-`));
    cleanup.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests/unit'), { recursive: true });
    await writeFile(join(root, 'src/one.ts'), 'export const one = 1;\n', 'utf8');
    await writeFile(join(root, 'tests/unit/declared.test.ts'), 'export const declared = 0;\n', 'utf8');
    await writeFile(join(root, 'tests/unit/pre-existing.test.ts'), 'export const preExisting = 0;\n', 'utf8');
    await createTask({
        root,
        id,
        title: id,
        ownedPaths: ['src/one.ts', 'src/two.ts', 'tests/unit/declared.test.ts', 'tests/unit/pre-existing.test.ts'],
        acceptance: [{ id: 'AC-1', statement: 'a pre-existing test may be cited' }],
        acceptanceMatrix: {
            version: 1,
            rows: [
                {
                    acceptanceId: 'AC-1',
                    implementationPaths: ['src/one.ts'],
                    testPaths: ['tests/unit/declared.test.ts'],
                    evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/declared.test.ts' }],
                    verificationLevel: 'unit',
                },
            ],
        },
    } as never);
    // The cited test is sealed into the base; the delta is the later change to src/two.ts.
    const base = await createTaskRevision({
        root, taskId: id,
        ownedPaths: ['src/one.ts', 'tests/unit/declared.test.ts', 'tests/unit/pre-existing.test.ts'],
        checkIds: [],
    });
    await writeFile(join(root, 'src/two.ts'), 'export const two = 2;\n', 'utf8');
    const current = await createTaskRevision({
        root, taskId: id,
        ownedPaths: ['src/one.ts', 'src/two.ts', 'tests/unit/declared.test.ts', 'tests/unit/pre-existing.test.ts'],
        checkIds: [],
    });
    return { root, base: base.id, current: current.id };
}

describe('a pass may cite a test the sealed revision carried without changing it', () => {
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('is not refused as an undeclared test path', async () => {
        const { root, base, current } = await fixture('citation');
        const { issueAdversarialBrief, adversarialGateFor } = await import('../../src/quality/adversarial.js');
        const { recordAdversarialPass } = await import('../helpers/adversarial.js');
        const { buildChangeRecord, changeRecordPath } = await import('../../src/quality/change-record.js');
        const { readTaskRevision } = await import('../../src/workflow/revision.js');
        const { writeFile: write } = await import('node:fs/promises');

        // The sealed change record for **this** revision: the half the mutation changes.
        const revision = await readTaskRevision(root, 'citation', current);
        const record = await buildChangeRecord({
            root,
            taskId: 'citation',
            revisionId: current,
            ownedPaths: ['src/one.ts', 'src/two.ts', 'tests/unit/declared.test.ts', 'tests/unit/pre-existing.test.ts'],
            evidence: [],
            claimFailures: [],
            findings: [],
            contentDigests: { 'src/one.ts': 'aaa', 'src/two.ts': 'bbb' },
            baseContentDigests: { 'src/one.ts': 'aaa' },
        });
        await write(changeRecordPath(root, 'citation'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        const brief = await issueAdversarialBrief(root, 'citation', 'review', { since: base });
        const declared = brief.ir?.scope?.kind === 'delta' ? [...brief.ir.scope.changedPaths] : [];
        expect(declared).toContain('src/two.ts');
        expect(declared).not.toContain('tests/unit/pre-existing.test.ts');
        expect(revision?.manifestHash).toBeTruthy();

        await recordAdversarialPass(root, 'citation', 'review', {
            hypotheses: [
                {
                    id: 'h-cites-a-test',
                    claim: 'the delta is accounted for by re-running a test the revision already carried',
                    targets: ['AC-1', ...declared],
                    method: 'permitted-test',
                    outcome: 'refuted',
                    observation: { kind: 'test', ref: 'tests/unit/pre-existing.test.ts', observed: 'the pre-existing test was re-run' },
                },
            ],
            attempts: [
                {
                    hypothesis: 'h-cites-a-test',
                    method: 'permitted-test',
                    outcome: 'refuted',
                    evidence: 'ran node --test tests/unit/pre-existing.test.ts and it passed',
                },
            ],
        });

        const gate = await adversarialGateFor(root, 'citation', 'review');
        expect(gate.reason).not.toBe('undeclared_test_path');
    }, 60000);
});
