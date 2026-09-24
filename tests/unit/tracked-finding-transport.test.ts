import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { readTrackedFindings } from '../../src/quality/finding-disposition.js';
import { roundMayClose } from '../../src/quality/finding-lifecycle.js';

/**
 * **The transport carries the contract fields — `rba8-f1`, blocking.**
 *
 * `track()` rebuilds each tracked finding field by field, and it copied neither `classInstances`, `impact` nor `falsifier` while
 * `TrackedFinding` declared all three. Consequence, measured: `roundMayClose` received a list whose `classInstances` was always
 * `undefined`, so `classesNeedingCoverage` returned `[]` and **the verdict was `mayClose: true` unconditionally at both production
 * call sites** — the termination condition this change exists to provide could not fail. `repairBriefing`'s tracked branch emitted no
 * `impact` or `classInstances`, and `classesOfFindings` could never acquire a class for a finding a pass had filed.
 *
 * This is the class table's first and third entries wearing each other's clothes: a **declaration** (the interface names the fields)
 * whose **transport** does not carry them, which makes every downstream check **unable to fail**. Nothing tested the transport —
 * `class-invariants.test.ts`'s E block calls `roundMayClose` directly with hand-built findings, so it stayed green while the wired
 * consumer passed `undefined`.
 *
 * The falsifier is this file: delete the three spreads from `track()`'s return and both cases redden.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function taskWithAdversarialFinding(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-transport-'));
    roots.push(root);
    await initLayout(root);
    await createTask({ root, id: 't-task', title: 'Transport', acceptance: [{ id: 'AC-1', statement: 'x' }] });
    await mkdir(join(root, '.kata/tasks/t-task'), { recursive: true });
    // Written into the adversarial record, which is the store a pass writes — the branch that was broken.
    await writeFile(join(root, '.kata/tasks/t-task/adversarial-review.json'), `${JSON.stringify({
        node: 'review', status: 'recorded', revisionId: 'revision-x',
        hypotheses: [{ id: 'h1', claim: 'c', targets: ['src/a.ts'], method: 'source-read', outcome: 'confirmed' }],
        attempts: [],
        findings: [{
            id: 'pass-filed', taskId: 't-task', severity: 'major', message: 'a pass filed this one',
            path: 'src/a.ts',
            impact: 'the six fixtures that exercise src/b.ts',
            classInstances: ['one-concept-several-derivations'],
            falsifier: 'delete the spread and this case reddens',
            // `rba10-f3`: the transport is by-name, so a field the contract declares and `track()` does not name is dropped
            // silently — this is the fourth it had already dropped while the three it was fixed for were asserted.
            reproduction: { findingId: 'pass-filed', ranChecks: [{ checkId: 'e-ac-1', passed: true }], missingTest: false },
        }],
        createdAt: '2026-09-24T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');
    return root;
}

describe('a finding survives the transport that reads it', () => {
    it('readTrackedFindings carries impact, classInstances and falsifier', async () => {
        const root = await taskWithAdversarialFinding();
        const tracked = await readTrackedFindings(root, 't-task');
        const finding = tracked.find((entry) => entry.id === 'pass-filed');
        expect(finding).toBeDefined();
        expect(finding?.impact).toContain('six fixtures');
        expect(finding?.classInstances).toEqual(['one-concept-several-derivations']);
        expect(finding?.falsifier).toContain('delete the spread');
        // The fourth field, added by `rba10-f3`: the assertion is why the class is now pinned per field rather than per fix.
        expect(finding?.reproduction?.ranChecks?.[0]?.checkId).toBe('e-ac-1');
    });

    it('roundMayClose can fail when it is fed from the real reader rather than hand-built findings', async () => {
        const root = await taskWithAdversarialFinding();
        const tracked = await readTrackedFindings(root, 't-task');
        const open = tracked
            .filter((finding) => finding.disposition === 'open')
            .map((finding) => ({ id: finding.id, severity: finding.severity, ...(finding.classInstances ? { classInstances: finding.classInstances } : {}) }));
        // The class table is empty on purpose: the finding names a class, and no check covers it. Before the transport fix this
        // returned mayClose: true, because classInstances was undefined and the class table therefore had nothing to judge.
        const verdict = roundMayClose(open, []);
        expect(verdict.mayClose).toBe(false);
        expect(verdict.reason).toContain('one-concept-several-derivations');
    });
});

/**
 * **The record and its history are written under the task lock** — `rba10-f4`.
 *
 * They are the artefact this change exists to make trustworthy, and they were the one pair of files in a task written outside the
 * lock while the dispositions stored beside them were written inside it. `withTaskLock` refuses re-entry by creating a lock
 * directory, so a helper that only locked the write would leave the read-modify-write window open — which is the window the
 * history's "read the record being replaced, append it, write both" sequence depends on.
 *
 * The falsifier is the refusal rather than the timing: with the lock held, a second writer must be refused, and without the lock it
 * is not.
 */
describe('the adversarial record is written under the task lock', () => {
    it('refuses a concurrent write rather than interleaving with it', async () => {
        const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { withTaskLock } = await import('../../src/core/state.js');
        const { writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-lock-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'lock-task', title: 'L', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            const record = {
                node: 'review', status: 'recorded', revisionId: 'revision-abcdef0123456789',
                hypotheses: [{ id: 'h1', claim: 'c', targets: ['src/a.ts'], method: 'source-read', outcome: 'confirmed' }],
                attempts: [], findings: [], createdAt: '2026-09-24T00:00:00.000Z',
            };
            // A writer holding the lock: the record write must be refused, not silently interleaved.
            const refused = await withTaskLock(root, 'lock-task', () =>
                writeAdversarialRecord(root, 'lock-task', record as never).then(() => 'wrote', (error: Error) => error.message));
            expect(String(refused)).toContain('state transition in progress');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
