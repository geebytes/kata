import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { READABLE_SEVERITIES, SEVERITIES } from '../../src/kernel/types.js';
import { mergeBlockingSeverities } from '../../src/quality/review-ladder.js';
import type { ReviewSeverity } from '../../src/quality/reviewer.js';
import { taskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-6 — one severity vocabulary, and a merge-blocking severity carries a basis.**
 *
 * Three definitions of the same word disagreed: the claim side allowed `nit` and not `note`, the finding schema allowed
 * both, and `ReviewSeverity` allowed `note` and not `nit` — so a record could be written with a severity one of its
 * readers had no name for, and a writer could mint a spelling another writer was refused. That is the shape this repository
 * keeps paying for: one fact, several spellings, and the disagreement surfaces at the reader that happens not to know one
 * of them.
 *
 * The second half is about what `blocking` *means*. It is the severity that refuses an approval, and until now it was a
 * bare word: a round could file `blocking` with no criterion, no statement of what it falsified, and nothing to check the
 * word against. A merge-blocking severity now names its basis — the acceptance criterion it falsifies, or, where no
 * criterion covers it, what it does falsify, in words. Neither is optional and neither is inferred.
 */
const roots: string[] = [];
const taskId = 'severity-basis';

async function tempRoot(options: { matrix?: boolean } = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-severity-'));
    roots.push(root);
    await initLayout(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'thing.ts'), 'export const holds = true;\n');
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    const record = taskRecord({
        id: taskId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }, { id: 'AC-2', statement: 'The thing is reachable.' }],
        ownedPaths: ['src/thing.ts'],
    });
    // **Composed rather than passed through.** `writeTaskRecord`'s input does not carry `acceptanceMatrix`, so a fixture
    // that spreads one into that call writes a record with no matrix at all — silently, because an object spread is not an
    // excess-property error. Measured here first: the case that asserts a citation resolves read "this task's acceptance
    // matrix does not hold AC-1" against a fixture that had declared it.
    if (options.matrix !== false) {
        record.acceptanceMatrix = {
            version: 1,
            rows: [
                { acceptanceId: 'AC-1', implementationPaths: ['src/thing.ts'], testPaths: ['tests/unit/thing.test.ts'], evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/thing.test.ts' }], verificationLevel: 'unit' },
                { acceptanceId: 'AC-2', implementationPaths: ['src/thing.ts'], testPaths: ['tests/unit/thing.test.ts'], evidence: [{ id: 'ac-2', kind: 'test', command: 'vitest', testSelector: 'tests/unit/thing.test.ts' }], verificationLevel: 'unit' },
            ],
        };
    }
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify(record, null, 2)}\n`);
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/thing.ts'], checkIds: [] });
    // Recording a result is a review-phase operation; the round itself is what these cases are about, so the phase is
    // staged rather than entered (entering it writes a placeholder this file does not need).
    await writeCurrentState(root, {
        taskId,
        phase: 'review',
        actor: { id: 'kata-agent', role: 'implementer' },
        updatedAt: '2026-10-09T00:00:00.000Z',
    });
    return root;
}

async function record(root: string, findings: unknown[]): Promise<{ success: boolean; error?: string }> {
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'tmp', 'round.json'), `${JSON.stringify({ findings })}\n`);
    return { ...(await runCommand('review', taskId, root, { reviewResultFile: 'tmp/round.json' })) };
}

const finding = (body: Record<string, unknown>) => ({ id: 'F-1', taskId, message: 'the thing does not hold', ...body });

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('one severity vocabulary', () => {
    it('is one list, and the readable list is the write list plus the retirement', () => {
        // The write set is what a writer may mint; `nit` stays readable because records exist that hold it. This is the
        // split the assurance vocabulary already uses, for the same reason: a reader that cannot read a record of record
        // has destroyed the record.
        expect([...SEVERITIES]).toEqual(['blocking', 'major', 'minor', 'note']);
        expect([...READABLE_SEVERITIES]).toEqual(['blocking', 'major', 'minor', 'note', 'nit']);

        // The review ladder's own type is the readable set, and the two ladder modes name what actually blocks.
        const severe: ReviewSeverity[] = [...READABLE_SEVERITIES];
        expect(severe).toHaveLength(5);
        expect([...mergeBlockingSeverities('strict')]).toEqual(['blocking', 'major']);
        expect([...mergeBlockingSeverities('standard')]).toEqual(['blocking']);
    });
});

describe('a merge-blocking finding names its basis', () => {
    it('accepts `blocking` that names a criterion the matrix holds', async () => {
        const root = await tempRoot();

        const recorded = await record(root, [finding({ severity: 'blocking', acceptanceId: 'AC-1' })]);

        expect(recorded.error, JSON.stringify(recorded)).toBeUndefined();
        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { findings?: Array<{ acceptanceId?: string }> };
        expect(review.findings?.[0]?.acceptanceId).toBe('AC-1');
    });

    it('refuses `blocking` with no basis at all, and `major` likewise', async () => {
        const root = await tempRoot();

        const bare = await record(root, [finding({ severity: 'blocking' })]);
        expect(bare.success).toBe(false);
        // The refusal names the criteria that would satisfy it, so it is actionable rather than a wall.
        expect(String(bare.error)).toContain('AC-1');
        // The refusal names the two ways to satisfy it, so it is actionable rather than a wall.
        expect(String(bare.error)).toContain('falsifies');

        const major = await record(root, [finding({ severity: 'major' })]);
        expect(major.success).toBe(false);
        expect(String(major.error)).toContain('major');

        // Nothing was written by either refusal.
        await expect(readFile(reviewPath(root, taskId), 'utf8')).rejects.toThrow();
    });

    it('accepts a stated basis where no criterion covers the problem, and refuses an empty one', async () => {
        const root = await tempRoot();

        // A blocking defect outside the acceptance contract is a real thing; forcing it to cite a criterion would let it be
        // filed as `minor` instead, which is weaker than what this rule is for.
        const stated = await record(root, [finding({ severity: 'blocking', falsifies: 'the export can be observed from outside the module' })]);
        expect(stated.error, JSON.stringify(stated)).toBeUndefined();

        const root2 = await tempRoot();
        const blank = await record(root2, [finding({ severity: 'major', falsifies: '   ' })]);
        expect(blank.success).toBe(false);
        expect(String(blank.error)).toContain('falsifies');
    });

    it('refuses a citation the matrix does not hold, so the basis cannot be a plausible-looking id', async () => {
        const root = await tempRoot();

        const invented = await record(root, [finding({ severity: 'blocking', acceptanceId: 'AC-99' })]);

        expect(invented.success).toBe(false);
        expect(String(invented.error)).toContain('AC-99');
    });

    it('leaves the ungated severities alone, and keeps a legacy task readable', async () => {
        const root = await tempRoot();
        // `minor` and `note` do not refuse an approval, so they carry no basis requirement — the rule is about the word
        // that decides whether a change may pass.
        const minor = await record(root, [finding({ severity: 'minor' })]);
        expect(minor.error, JSON.stringify(minor)).toBeUndefined();

        // **A task without a matrix still has criteria, and citing one of them is an accurate citation.** The first version
        // of this rule resolved only against the matrix rows, so a legacy task's finding that named `AC-1` — a criterion the
        // task really declares — was refused: rejecting an accurate citation is a defect of its own (see the admissibility
        // contract), and the matrix is the declared row set *for* those criteria rather than a second, better list of them.
        const legacy = await tempRoot({ matrix: false });
        const legacyNamed = await record(legacy, [finding({ severity: 'blocking', acceptanceId: 'AC-1' })]);
        expect(legacyNamed.error, JSON.stringify(legacyNamed)).toBeUndefined();

        // A stated basis is what remains for a finding outside the contract entirely.
        const root3 = await tempRoot();
        const outside = await record(root3, [finding({ severity: 'major', falsifies: 'a path the criteria never mention' })]);
        expect(outside.error, JSON.stringify(outside)).toBeUndefined();
    });

    it('refuses a severity outside the readable vocabulary by name, rather than filing it under a neighbour', async () => {
        const root = await tempRoot();

        const wrong = await record(root, [finding({ severity: 'medium', falsifies: 'something' })]);

        expect(wrong.success).toBe(false);
        expect(String(wrong.error)).toContain('severity');
        expect(String(wrong.error)).toContain('medium');
    });
});
