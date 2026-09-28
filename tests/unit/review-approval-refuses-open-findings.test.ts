import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaim, freezeSubject, writeSubject } from '../../src/store/ledger.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { describeBlockingProblems, type MergeBlockingProblem } from '../../src/workflow/review-read.js';
import { makeClaim } from '../helpers/review.js';

/**
 * The bar a mode has was not readable from the refusal.
 *
 * `review --approve` refused with the ledger's reason codes — `below_strength (C1): …` — which say *that* the ledger does
 * not pass. Which of those reasons the change's own review mode cares about lived nowhere the operator could read: the
 * severity rule was spread over three routers, and the approval path had stopped consulting it altogether. The refusal now
 * names every problem at the mode's bar, using the same ladder the routers read, so the sentence and the routing cannot
 * disagree about what blocks.
 *
 * The one clause of AC-3 that stays out of reach, recorded rather than faked: "a review whose findings are all **below**
 * the bar still approves" has no witness on the ledger route, because the kernel refuses *any* unsupported claim whatever
 * its severity — severity decides how strong the evidence must be, not whether the ledger passes. A below-bar problem
 * therefore still refuses, and this suite pins that instead of pretending otherwise.
 */
let root: string;
const changeId = 'bar-fixture';

async function writeTask(reviewMode: string): Promise<void> {
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode } }, null, 2)}\n`,
    );
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-bar-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'holds\n');
    await writeTask('strict');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'current-state.json'),
        `${JSON.stringify({ taskId: changeId, phase: 'review', actor: { id: 'test', role: 'reviewer' }, updatedAt: '2026-09-28T00:00:00.000Z' }, null, 2)}\n`,
    );
    // A ledger that is decided and does not pass: one claim, at the severity this suite varies, with no evidence behind it.
    const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (subject.ok) await writeSubject(root, changeId, subject.subject);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('the refusal names the problems at the mode\'s bar', () => {
    it('names each problem and the bar it was measured against', () => {
        const problems: MergeBlockingProblem[] = [
            { source: 'claim', id: 'C-1', severity: 'blocking', message: 'the first problem' },
            { source: 'claim', id: 'C-2', severity: 'major', message: 'the second problem' },
        ];
        expect(describeBlockingProblems('strict', problems)).toBe(
            'At the strict bar (blocking, major), 2 problem(s) are open: C-1 (blocking): the first problem | C-2 (major): the second problem',
        );
        // Standard's bar holds one severity, and the sentence says so rather than listing the strict one.
        expect(describeBlockingProblems('std', problems)).toContain('At the standard bar (blocking),');
        expect(describeBlockingProblems('security', problems)).toContain('At the security bar (blocking, major),');
    });

    it('adds nothing when no open problem reaches the bar', () => {
        expect(describeBlockingProblems('strict', [])).toBe('');
    });

    it('refuses the approval while a problem at the bar is open, and names it', async () => {
        await appendClaim(root, changeId, makeClaim({ id: 'C-9', severity: 'blocking', evidenceIds: [], dependsOn: ['path:src/a.ts'] }));

        const result = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'the ledger does not pass, so this approval must not be recorded',
            confirmHostModel: true,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('C-9');
        expect(result.error).toContain('blocking');
        expect(result.error).toContain('At the strict bar (blocking, major)');
        // The same answer the routers read, carried on the refusal rather than recomputed by a reader.
        expect(result.diagnostics?.blockingProblems).toEqual([
            { source: 'claim', id: 'C-9', severity: 'blocking', message: expect.any(String) },
        ]);
    });

    it('names a major problem under strict, and stays silent about it under standard', async () => {
        await appendClaim(root, changeId, makeClaim({ id: 'C-4', severity: 'major', evidenceIds: [], dependsOn: ['path:src/a.ts'] }));

        const strict = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'strict blocks on major, so this refusal names it',
            confirmHostModel: true,
        });
        expect(strict.success).toBe(false);
        expect(strict.error).toContain('At the strict bar (blocking, major)');
        expect(strict.error).toContain('C-4 (major)');
        expect(strict.diagnostics?.blockingProblems).toHaveLength(1);

        await writeTask('std');
        const std = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'standard blocks on blocking alone, so it names nothing here',
            confirmHostModel: true,
        });
        // **The mode decides what is named, not whether the ledger passes.** Standard's bar holds `blocking` alone, so
        // this problem is below it and the sentence does not claim a strict bar the task does not have. The approval is
        // still refused — by the kernel, which refuses an unsupported claim whatever its severity — and that is the
        // clause of AC-3 this route cannot witness: a below-bar problem does not become approvable.
        expect(std.success).toBe(false);
        expect(std.error).not.toContain('At the standard bar');
        expect(std.error).not.toContain('At the strict bar');
        expect(std.diagnostics?.blockingProblems).toEqual([]);
    });
});
