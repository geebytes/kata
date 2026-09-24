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
