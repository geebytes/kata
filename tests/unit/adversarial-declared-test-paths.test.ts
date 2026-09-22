import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, type AcceptanceMatrix } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { adversarialGateFor, issueAdversarialBrief, writeAdversarialRecord } from '../../src/quality/adversarial.js';

/**
 * The anti-counterexample guard refuses a test path the change does not declare — not *any* test path.
 *
 * `evaluateAdversarialGate` refuses with `undeclared_test_path` when an attempt's evidence cites a test outside
 * `declaredTestSelectors`, but no caller ever passed that field, so the refusal was unconditional in practice: the same
 * record was refused with the field absent and accepted with it present. That inverted the rule — an honest reviewer
 * naming the test it re-ran was blocked from concluding, while one describing its work without a path passed. The field
 * is now derived from the sealed task's own declaration, and a task that declares no tests is not blocked at all.
 */
describe('the declared test paths a pass may cite', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const cited = 'tests/unit/alpha.test.ts';

    async function sealedTask(id: string, matrix?: AcceptanceMatrix): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root, id, title: 'Declared tests', acceptance: [{ id: 'AC-1', statement: 'A test is cited.' }],
            ...(matrix ? { acceptanceMatrix: matrix } : {}),
        });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
        await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
        return root;
    }

    async function record(root: string, taskId: string): Promise<void> {
        const brief = await issueAdversarialBrief(root, taskId, 'review', { mode: 'cold' });
        await writeAdversarialRecord(root, taskId, {
            node: 'review', status: 'recorded', revisionId: brief.revisionId ?? '',
            createdAt: new Date().toISOString(), executedInFreshContext: true, contextNote: 'fixture',
            briefSha256: brief.sha256,
            // R2: the judgement basis the gate derives its verdict from. The pass speaks for the criterion and the
            // change surface; the `attempts` entry below is what carries the cited test path this file is about.
            hypotheses: [{
                id: 'h1',
                claim: 'the cited test path is the one the task declares',
                targets: ['AC-1', 'src/x.ts'],
                method: 'permitted-test',
                outcome: 'refuted',
                // R8: the observation cites the file this fixture wrote (`src/x.ts`) — a real path at this revision, where
                // the old citation-free `analysis` rule accepted a made-up analyzer name.
                observation: { kind: 'source', ref: 'src/x.ts', observed: 'the cited path is declared' },
            }],
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted', evidence: `ran ${cited} — 3 passed` }],
            findings: [],
        });
    }

    function matrixWith(testPaths: string[]): AcceptanceMatrix {
        return {
            version: 1,
            rows: [{
                acceptanceId: 'AC-1',
                implementationPaths: ['src/x.ts'],
                testPaths,
                // A declaration with no evidence item is invalid, so the row carries the test check it is proved by.
                evidence: [{ kind: 'test', command: 'npm test' }],
                verificationLevel: 'unit',
            }],
        };
    }

    it('accepts a round citing a test the task declares', async () => {
        const root = await sealedTask('declares-it', matrixWith([cited]));
        await record(root, 'declares-it');
        const gate = await adversarialGateFor(root, 'declares-it', 'review');
        expect(gate.satisfied).toBe(true);
    });

    it('refuses a round citing a test the task does not declare', async () => {
        const root = await sealedTask('declares-other', matrixWith(['tests/unit/other.test.ts']));
        await record(root, 'declares-other');
        const gate = await adversarialGateFor(root, 'declares-other', 'review');
        // This is the rule doing its job: a counterexample the change never declared does not enter the evidence.
        expect(gate).toMatchObject({ satisfied: false, reason: 'undeclared_test_path' });
    });

    it('does not block a task that declares no tests', async () => {
        const root = await sealedTask('declares-none');
        await record(root, 'declares-none');
        const gate = await adversarialGateFor(root, 'declares-none', 'review');
        // With nothing declared there is nothing to cite *outside of*: the rule's own words ("no declaration on this
        // revision named it") are vacuously true of every path, so it does not fire. This is the case that made the guard
        // refuse honest rounds — a task with no matrix declares no tests, and every path a reviewer mentioned failed.
        expect(gate.satisfied).toBe(true);
    });
});
