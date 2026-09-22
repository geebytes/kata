import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, type AcceptanceMatrix } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { adversarialGateFor, issueAdversarialBrief, writeAdversarialRecord } from '../../src/quality/adversarial.js';

/**
 * §3.1.2's `grounding` conjunct has four observation kinds, and the gate only ever fed the predicate **one** of them.
 *
 * `evaluateAdmissibility` resolves an observation against the revision it is handed. The gate handed it `revisionId`,
 * `changedPaths` and `criterionIds` — and nothing else — while `RevisionUnderReview` also declares
 * `declaredTestSelectors`, `evidenceIds` and `readablePaths`. Measured, not assumed: a probe over the gate's own call
 * site reported `declaredTestSelectors? false`, `evidenceIds? false`, `readablePaths? false`.
 *
 * The consequence is that three of the four kinds could never resolve at the gate, no matter how honest the citation:
 * a `test` observation against a test the task declared, an `evidence` observation against an envelope sealed into this
 * very revision, and a `source` observation against a path that exists but that this revision did not change (the
 * revision's `pathDigests` is *not* a readable-paths list — it is a list of what changed).
 *
 * This file pins the contract: all four kinds resolve when the citation is accurate, and each still refuses when it is
 * not. A guard that refuses an accurate citation is the same defect class as one that accepts a vague one.
 */
describe('grounding resolves every observation kind at the gate', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const declared = 'tests/unit/alpha.test.ts';

    const matrix: AcceptanceMatrix = {
        version: 1,
        rows: [{
            acceptanceId: 'AC-1',
            implementationPaths: ['src/x.ts'],
            testPaths: [declared],
            evidence: [{ kind: 'test', command: 'npm test', testSelector: declared }],
            verificationLevel: 'unit',
        }],
    };

    /** A sealed task with one changed path, one declared test, and one evidence envelope bound to the revision. */
    async function sealedTask(id: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-grounding-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root, id, title: 'Grounding kinds',
            acceptance: [{ id: 'AC-1', statement: 'Observations resolve.' }],
            acceptanceMatrix: matrix,
        });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), 'export const x = 1;\n', 'utf8');
        // A path that exists in the repository but that this revision did not change.
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/untouched.md'), 'not changed here\n', 'utf8');
        await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
        return root;
    }

    async function recordWith(
        root: string,
        taskId: string,
        hypotheses: Array<Record<string, unknown>>,
    ): Promise<void> {
        const brief = await issueAdversarialBrief(root, taskId, 'review', { mode: 'cold' });
        await writeAdversarialRecord(root, taskId, {
            node: 'review', status: 'recorded', revisionId: brief.revisionId ?? '',
            createdAt: new Date().toISOString(), executedInFreshContext: true, contextNote: 'fixture',
            briefSha256: brief.sha256,
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted', evidence: 'read the code' }],
            findings: [],
            hypotheses,
        } as never);
    }

    const hypothesis = (observation: Record<string, unknown>): Record<string, unknown> => ({
        id: 'h1',
        claim: 'something is false',
        targets: ['AC-1', 'src/x.ts'],
        method: 'source-read',
        outcome: 'refuted',
        observation,
    });

    it('resolves a test observation against the test the task declared', async () => {
        const root = await sealedTask('ground-test');
        await recordWith(root, 'ground-test', [hypothesis({ kind: 'test', ref: declared, observed: '3 passed' })]);
        const gate = await adversarialGateFor(root, 'ground-test', 'review');
        expect(gate.satisfied).toBe(true);
    });

    it('resolves an evidence observation against an envelope bound to this revision', async () => {
        // (This case originally used `kind: 'analysis'` — the kind whose grounding was `ref.length > 0` — so it asserted
        // nothing about evidence. R8 replaced both halves: the analysis kind is now instrument-grounded, and this case
        // exercises the evidence kind with a real envelope id bound to the revision.)
        const root = await sealedTask('ground-evidence');
        const { collectEvidence, readRecordedEvidence } = await import('../../src/quality/evidence.js');
        const { readCurrentTaskRevision } = await import('../../src/workflow/revision.js');
        const revision = await readCurrentTaskRevision(root, 'ground-evidence');
        // The envelope has to be bound to *this* revision, and the only way that binding is set is by collecting against
        // it — a hand-written envelope with a hand-written `revisionId` would test the fixture, not the gate.
        const [envelope] = await collectEvidence('ground-evidence', [
            { kind: 'typecheck', command: 'npm run typecheck', importResult: { exitCode: 0 }, cwd: root },
        ], { revision: revision ?? undefined });
        if (!envelope) throw new Error('the fixture produced no envelope');
        // The seal persists each envelope as `${taskId}-${checkId ?? id}.json`; the same write here means the gate reads a
        // real file, and the binding under test (`revisionId`) is the one `collectEvidence` set — not one this test typed.
        await mkdir(join(root, '.kata/evidence'), { recursive: true });
        await writeFile(join(root, '.kata/evidence', `ground-evidence-${envelope.checkId ?? envelope.id}.json`), JSON.stringify(envelope), 'utf8');
        const ids = (await readRecordedEvidence(root, 'ground-evidence'))
            .filter((envelope) => envelope.revisionId === revision?.id)
            .map((envelope) => envelope.id);
        expect(ids.length).toBeGreaterThan(0);

        // An accurate citation resolves…
        await recordWith(root, 'ground-evidence', [hypothesis({ kind: 'evidence', ref: ids[0]!, observed: 'typecheck passed' })]);
        expect((await adversarialGateFor(root, 'ground-evidence', 'review')).satisfied).toBe(true);

        // …and an envelope id that was never sealed here does not.
        await recordWith(root, 'ground-evidence', [hypothesis({ kind: 'evidence', ref: 'no-such-envelope', observed: 'x' })]);
        expect((await adversarialGateFor(root, 'ground-evidence', 'review')).satisfied).toBe(false);
    });

    it('refuses an analysis observation that names no declared instrument', async () => {
        // R8, found by an adversarial pass on 2026-09-22: for `kind: 'analysis'` the grounding check was
        // `observation.ref.trim().length > 0` — no analyzer registry, no recorded result, no revision binding. Measured: a
        // hypothesis with `{kind:'analysis', ref:'q', observed:'z'}` was admitted with `satisfied: true`, which is a
        // citation-free discharge path that makes the other three grounding rules moot in practice.
        //
        // The property: an analysis citation must name something the task itself declared as an instrument.
        const root = await sealedTask('ground-analysis');
        await recordWith(root, 'ground-analysis', [hypothesis({ kind: 'analysis', ref: 'q', observed: 'z' })]);
        expect(await adversarialGateFor(root, 'ground-analysis', 'review')).toMatchObject({ satisfied: false, reason: 'incomplete' });

        // The declared instrument (this task's matrix names `npm test`) does resolve.
        await recordWith(root, 'ground-analysis', [hypothesis({ kind: 'analysis', ref: 'npm test', observed: 'the declared check reported 0 failures' })]);
        expect((await adversarialGateFor(root, 'ground-analysis', 'review')).satisfied).toBe(true);
    });

    it('resolves a source observation against an unchanged path, because the revision is not a readable-paths list', async () => {
        const root = await sealedTask('ground-unchanged');
        await recordWith(root, 'ground-unchanged', [hypothesis({ kind: 'source', ref: 'docs/untouched.md#L1', observed: 'the file is a stub' })]);
        const gate = await adversarialGateFor(root, 'ground-unchanged', 'review');
        expect(gate.satisfied).toBe(true);
    });

    it('still refuses a source observation that names a path the repository does not have', async () => {
        const root = await sealedTask('ground-missing');
        await recordWith(root, 'ground-missing', [hypothesis({ kind: 'source', ref: 'src/does-not-exist.ts#L1', observed: 'x' })]);
        const gate = await adversarialGateFor(root, 'ground-missing', 'review');
        expect(gate).toMatchObject({ satisfied: false, reason: 'incomplete' });
    });

    it('still refuses a test observation naming a test the task did not declare', async () => {
        const root = await sealedTask('ground-undeclared');
        await recordWith(root, 'ground-undeclared', [hypothesis({ kind: 'test', ref: 'tests/unit/authored.test.ts', observed: 'passed' })]);
        const gate = await adversarialGateFor(root, 'ground-undeclared', 'review');
        expect(gate.satisfied).toBe(false);
    });
});
