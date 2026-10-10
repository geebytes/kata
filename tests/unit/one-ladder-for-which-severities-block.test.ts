import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { isMergeBlocking, mergeBlockingSeverities, reviewTierFor } from '../../src/quality/review-ladder.js';
import { isMergeBlockingSeverity, mergeBlockingSeveritiesForTier } from '../../src/kernel/types.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-6, the half an independent round found missing: the "which severities block" question has one derivation.**
 *
 * The set was computed twice — by the ladder (which spells the mode correctly, accepts `std` as well as `standard`, and treats
 * an absent mode as the std ladder) and by a predicate in the kernel that parsed the mode itself
 * (`mode === 'standard' ? … : …`, defaulting to `strict`). The two disagreed on exactly the two cases that matter:
 *
 * | mode       | ladder blocks  | the second derivation said `major` |
 * |------------|----------------|------------------------------------|
 * | `std`      | `blocking`     | blocks                             |
 * | absent     | `blocking`     | blocks (defaulted to strict)        |
 *
 * and the divergent one was load-bearing: the review record demanded a **basis** for a `major` finding under a mode whose
 * ladder does not block on `major` at all. Measured on a `std` task, a legitimate round was refused —
 *
 *     finding F-1 is major, and a merge-blocking severity must name its basis
 *
 * The fix is not to teach both functions the spelling table: it is that **only one function reads the mode**. The kernel
 * answers per *tier*; the ladder is the only place that turns a mode into a tier; and the record path asks the ladder.
 */
const roots: string[] = [];
const taskId = 'one-ladder-for-severities';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every spelling a mode can arrive as, plus the ones that must fail closed. */
const MODES: Array<string | undefined> = ['std', 'standard', 'strict', 'security', undefined, '', '  STD ', 'securty', 'Strict'];

describe('which severities block has one derivation', () => {
    it('answers the same way whichever function is asked, for every mode spelling', () => {
        for (const mode of MODES) {
            const tier = reviewTierFor(mode);
            const fromLadder = mergeBlockingSeverities(mode);
            const fromKernel = mergeBlockingSeveritiesForTier(tier);
            const label = `mode=${JSON.stringify(mode)} → tier ${tier}`;

            // The ladder's set *is* the kernel's set for the tier the ladder resolved: one fact, one value.
            expect(fromLadder, label).toEqual(fromKernel);
            // **And it is the same value, not an equal one.** `toEqual` cannot tell a delegation from a second construction
            // that happens to agree — measured by an independent round: re-adding the ladder's own local copy (correct this
            // time: `reviewTierFor(mode) === 'standard' ? ['blocking'] : ['blocking','major']`) left every case green. The
            // identity below fails for any implementation that builds its own array, which is the property AC-6 states.
            expect(fromLadder, `${label}: the ladder must return the kernel's own value`).toBe(fromKernel);
            expect(Object.isFrozen(fromLadder), `${label}: the set is not mutable state`).toBe(true);
            for (const severity of ['blocking', 'major', 'minor', 'note', 'nit']) {
                // And the two predicates agree with that set — including `major` under `std` and under an absent mode, which
                // is where they used to disagree and where a legitimate round was refused.
                expect(isMergeBlocking(mode, severity), `${label}, severity=${severity}`).toBe(fromLadder.includes(severity));
                expect(isMergeBlockingSeverity(severity, tier), `${label}, severity=${severity}`).toBe(fromLadder.includes(severity));
            }
        }
    });

    it('names the std ladder for the spellings that mean it, and fails closed on one nobody can name', () => {
        for (const std of ['std', 'standard', '  STD ', undefined, '']) {
            expect(reviewTierFor(std), JSON.stringify(std)).toBe('standard');
            expect(mergeBlockingSeverities(std), JSON.stringify(std)).toEqual(['blocking']);
        }
        // An unknown spelling is the strictest ladder, not the weakest: dropping the strongest tier to the weakest is the
        // fail-open direction.
        expect(reviewTierFor('securty')).toBe('security');
    });
});

describe('a round is judged by the ladder its own mode names', () => {
    async function stdTask(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-one-ladder-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeTaskRecord(root, {
            id: taskId,
            phase: 'hardVerify',
            acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
            ownedPaths: ['src/a.ts'],
            // The ladder this task's own profile names, and the one whose answer the record must use.
            workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'std' },
        });
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/a.ts'], checkIds: [] });
        await writeCurrentState(root, { taskId, phase: 'review', actor: { id: 'kata-reviewer', role: 'reviewer' }, updatedAt: '2026-10-09T00:00:00.000Z' });
        return root;
    }

    it('accepts a major finding with no basis under std, because that ladder does not block on it', async () => {
        const root = await stdTask();
        await writeFile(join(root, 'tmp-round.json'), `${JSON.stringify({ findings: [{ id: 'F-1', taskId, severity: 'major', message: 'no basis stated' }] })}\n`);

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: 'tmp-round.json' });

        // The record was refused before the fix, with a sentence about a merge-blocking severity under a mode that blocks only
        // on `blocking`.
        expect(recorded.success, JSON.stringify(recorded)).toBe(true);
        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { findings: Array<{ id: string; severity: string }> };
        expect(review.findings.map((finding) => `${finding.id}:${finding.severity}`)).toEqual(['F-1:major']);
    });

    it('still refuses the same finding under strict, where the ladder does block on it', async () => {
        const root = await stdTask();
        const profile = { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict' } as const;
        await writeTaskRecord(root, {
            id: taskId,
            phase: 'hardVerify',
            acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
            ownedPaths: ['src/a.ts'],
            workflowProfile: profile,
        });
        await writeFile(join(root, 'tmp-round.json'), `${JSON.stringify({ findings: [{ id: 'F-1', taskId, severity: 'major', message: 'no basis stated' }] })}\n`);

        // The command reports its refusal rather than throwing, so the sentence is read from the result — an assertion on a
        // `.catch()` that never runs would have passed for the wrong reason.
        const refused = await runCommand('review', taskId, root, { reviewResultFile: 'tmp-round.json' });

        expect(refused.success).toBe(false);
        expect(String(refused.error)).toContain('must name its basis');
    });
});
