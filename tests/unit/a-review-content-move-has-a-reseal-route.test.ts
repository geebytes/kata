import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { assertRepairBaselineStillCurrent, authorizeReviewRepair } from '../../src/workflow/repair-entry.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-14 — the review-phase state with no route out.**
 *
 * Measured downstream (a `strict` change): a declared path was edited during `review` — the ordinary act of repairing a
 * review finding — and from there `build --seal` refused while telling the operator to re-run `/kata-review`; `ledger run`
 * refused and told them to re-seal; `review` demanded a conclusion bound to a revision that no longer existed; and
 * `verify`'s own `nextAction` was the refused `build --seal`. Four commands, one cycle, no exit.
 *
 * **What this file measured while it was being written, and had to correct.** The state the report describes as
 * `currentRevisionId: None` is *already* authorized when the pointer is still on disk: `boundToCurrentRevision` compares
 * the frozen candidate of the workspace against the round's, but a pointer naming the same revision still binds by id, and
 * the supersede authorisation below then admits the entry. Measured on an unmodified tree: pointer present → authorized;
 * pointer absent → refused. So the only state with no route out is **the one where the pointer is gone**, and that is what
 * these cases pin. The pointer-present case is kept as a regression pin rather than as this change's subject.
 *
 * The admission is deliberately narrow: it needs a recorded round that names a revision **that is still stored and no
 * longer describes its content**. A missing round, a round naming a revision nobody stored, a round and pointer that
 * disagree, and a revision that still describes its content all keep the refusal they had.
 */
const roots: string[] = [];
const taskId = 'reseal-after-review-move';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-reseal-'));
    roots.push(root);
    await initLayout(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await writeFile(join(root, 'thing.ts'), 'export const holds = true;\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
    return root;
}

/** A check that really runs and really passes, so the seal's own gate is satisfied rather than bypassed. */
const passingCheck = (root: string) => ({ kind: 'test' as const, command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root });

const pointerPath = (root: string) => join(root, '.kata', 'tasks', taskId, 'current-revision.json');

interface Fixture {
    root: string;
    revisionId: string;
}

async function seed(options: { pointer?: boolean; record?: boolean; recordRevisionId?: string } = {}): Promise<Fixture> {
    const root = await tempRoot();
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeTaskRecord(root, {
        id: taskId,
        phase: 'review',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['thing.ts'],
    });
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['thing.ts'], checkIds: ['test'] });
    await writeCurrentState(root, {
        taskId,
        phase: 'review',
        actor: { id: 'kata-reviewer', role: 'reviewer' },
        updatedAt: '2026-10-09T00:00:00.000Z',
    });
    if (options.record ?? true) {
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: options.recordRevisionId ?? sealed.revision.id,
            manifestHash: sealed.revision.manifestHash,
            status: 'pending',
            findings: [],
        }, null, 2)}\n`);
    }
    // The act this defect is about: repairing a review finding during review.
    await writeFile(join(root, 'thing.ts'), 'export const holds = false;\n');
    if (!(options.pointer ?? true)) await rm(pointerPath(root));
    return { root, revisionId: sealed.revision.id };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a review-phase content move has an executable re-seal route', () => {
    it('admits the entry when the pointer is gone, naming the seal the round was recorded against', async () => {
        const { root, revisionId } = await seed({ pointer: false });

        const authorization = await authorizeReviewRepair(root, taskId);

        expect(authorization.denial, authorization.denial).toBeUndefined();
        expect(authorization).toMatchObject({
            authorized: true,
            entryPhase: 'review',
            repair: { fromPhase: 'review', reason: 'revision_superseded', baselineRevisionId: revisionId },
        });
        // The baseline the admission recorded still describes the state it was decided on, which is what the writer
        // rechecks under the lock before the repair record lands.
        await expect(assertRepairBaselineStillCurrent(root, taskId, revisionId)).resolves.toBeUndefined();
    });

    it('runs the ladder it prints: build --seal enters implement, then seals a replacement revision', async () => {
        const { root, revisionId } = await seed({ pointer: false });
        const checks = [passingCheck(root)];

        const entered = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['thing.ts'], checks } as never);

        expect(entered.success, JSON.stringify(entered)).toBe(true);
        expect(entered.phase).toBe('implement');
        // The entry names the seal that follows it, and this case runs exactly that command next: a ladder whose second
        // rung refuses is the same defect one step further along.
        expect(String((entered.diagnostics as { sealCommand?: string } | undefined)?.sealCommand)).toContain('--seal');

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['thing.ts'], checks } as never);
        expect(sealed.success, JSON.stringify(sealed)).toBe(true);
        expect(sealed.phase).toBe('hardVerify');
        const pointer = JSON.parse(await readFile(pointerPath(root), 'utf8')) as { id: string };
        // A *replacement* seal, not the one that was superseded: a route that kept the old identity would leave the round
        // unbound exactly as before.
        expect(pointer.id).not.toBe(revisionId);
    });

    it('keeps the state that already had a route: a pointer on disk still admits the entry', async () => {
        // Regression pin, measured while writing this file: this state was already authorized before the admission was
        // widened, and the widening must not be what keeps it working.
        const { root, revisionId } = await seed();

        const authorization = await authorizeReviewRepair(root, taskId);

        expect(authorization).toMatchObject({
            authorized: true,
            repair: { reason: 'revision_superseded', baselineRevisionId: revisionId },
        });
    });

    it('does not open the door when there is no recorded round to re-seal against', async () => {
        const { root } = await seed({ pointer: false, record: false });

        const entered = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['thing.ts'], checks: [passingCheck(root)] } as never);

        // The absence of a review is its own refusal, and it must not be answered by "the seal is superseded" — that is
        // the general admission this change deliberately did not add.
        expect(entered.success).toBe(false);
        expect(String(entered.error)).toContain('without a recorded review');
    });

    it('does not open the door for a round that names a revision nobody stored', async () => {
        const { root } = await seed({ pointer: false, recordRevisionId: 'revision-never-stored' });

        const authorization = await authorizeReviewRepair(root, taskId);

        expect(authorization.authorized).toBe(false);
        expect(String(authorization.denial)).toMatch(/not bound to the current sealed revision/);
    });
});
