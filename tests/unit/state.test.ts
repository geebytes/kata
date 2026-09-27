import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { mutateTaskArtefact } from '../../src/core/state.js';
import { taskPath } from '../../src/core/layout.js';
import { readStateEventLog, transition, type Actor, type Phase } from '../../src/core/state.js';
import { recover, requiresRecovery } from '../../src/core/recovery.js';
import { computeDiffHash } from '../../src/quality/evidence.js';
import { createTaskRevision } from '../../src/workflow/revision.js';

describe('Kata task state transitions', () => {
    const roots: string[] = [];
    const actor: Actor = { id: 'agent-1', role: 'implementer' };

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-state-'));
        roots.push(root);
        await initLayout(root);
        return root;
    }

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('persists the legal intake to archive flow as append-only events plus current projection', async () => {
        const root = await tempRoot();
        const task = await createTask({
            root,
            id: 'task-flow',
            title: 'Exercise the complete state machine',
            acceptance: [{ id: 'AC-1', statement: 'Every governed phase is reachable in order.' }],
        });

        expect(task.phase).toBe('intake');

        const flow: Phase[] = ['plan', 'implement', 'hardVerify', 'review', 'judge', 'distill', 'archive'];
        for (const phase of flow) {
            if (phase === 'distill') await writePassingQualityGates(root, task.id);
            await transition(task.id, phase, actor, { root });
        }

        const current = JSON.parse(await readFile(join(root, '.kata/tasks/task-flow/current-state.json'), 'utf8')) as {
            phase: Phase;
        };
        expect(current.phase).toBe('archive');

        const events = (await readFile(join(root, '.kata/tasks/task-flow/state-events.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { to: Phase });

        expect(events.map((event) => event.to)).toEqual([
            'intake',
            'plan',
            'implement',
            'hardVerify',
            'review',
            'judge',
            'distill',
            'archive',
        ]);
    });

    it('refuses to recreate an existing task without overwriting its state', async () => {
        const root = await tempRoot();
        await createTask({ root, id: 'no-overwrite', title: 'Original', acceptance: [{ id: 'AC-1', statement: 'Keep state.' }] });
        await transition('no-overwrite', 'plan', actor, { root });

        await expect(createTask({ root, id: 'no-overwrite', title: 'Replacement', acceptance: [{ id: 'AC-1', statement: 'Must not replace.' }] }))
            .rejects.toThrow('already exists');
        await expect(readFile(join(root, '.kata/tasks/no-overwrite/current-state.json'), 'utf8')).resolves.toContain('"plan"');
    });

    it('rejects direct implement to archive transitions', async () => {
        const root = await tempRoot();
        const task = await createTask({
            root,
            id: 'task-illegal',
            title: 'Reject skipped gates',
            acceptance: [{ id: 'AC-1', statement: 'Archive requires all intermediate gates.' }],
        });

        await transition(task.id, 'plan', actor, { root });
        await transition(task.id, 'implement', actor, { root });

        await expect(transition(task.id, 'archive', actor, { root })).rejects.toThrow(/illegal transition/i);
    });

    it('recovers from a state log whose last line a crash truncated', async () => {
        // **The one situation the log exists for was the one it could not be read in.** Every line was parsed with
        // `JSON.parse`, and `requiresRecovery` reads the log *before* it can decide anything — so a truncating crash threw
        // a `SyntaxError` instead of recovering, and the tail damage a crash leaves is exactly what a tolerant reader has
        // to expect.
        const root = await tempRoot();
        const taskId = 'truncated-log';
        await initLayout(root);
        await createTask({ root, id: taskId, title: 'Truncated log', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await transition(taskId, 'plan', actor, { root });
        await transition(taskId, 'implement', actor, { root });
        const eventsPath = join(root, `.kata/tasks/${taskId}/state-events.jsonl`);
        const complete = await readFile(eventsPath, 'utf8');
        // A crash mid-append: the *last* line is cut one character short of its closing brace, which is the shape a
        // truncating crash leaves. The events before it are intact and must still replay.
        const lines = complete.split('\n').filter((line) => line !== '');
        expect(lines.length).toBeGreaterThanOrEqual(2);
        await writeFile(eventsPath, `${[...lines.slice(0, -1), lines[lines.length - 1]!.slice(0, -2)].join('\n')}\n`);

        const log = await readStateEventLog(root, taskId);
        expect(log.truncatedTail).toBe(true);
        expect(log.malformed).toBeGreaterThan(0);
        expect(log.events.length).toBeGreaterThan(0);
        expect(await requiresRecovery(taskId, { root })).toBe(true);
        // Recovery lands on the last *intact* event: the truncated tail is dropped and everything before it replays, which
        // is the strongest thing that can be said when a line was lost mid-write.
        const recovered = await recover(taskId, { root });
        expect(recovered.phase).toBe('plan');
        expect(recovered.actions.some((action) => action.startsWith('truncated-state-event-log'))).toBe(true);
    });

    it('steals a lock whose holder is older than the liveness bound, and keeps refusing a live one', async () => {
        // The lock was `mkdir`, and a process killed before its `finally` left the directory behind forever: every later
        // transition and every ledger mutation for that task failed with a message describing a transition that was not in
        // progress, and recovery never touched the lock. A lock now carries its holder and its start time.
        const root = await tempRoot();
        const taskId = 'stale-lock';
        await initLayout(root);
        await createTask({ root, id: taskId, title: 'Stale lock', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const lockPath = join(root, `.kata/tasks/${taskId}/.transition.lock`);

        // A fresh lock refuses, and says who holds it.
        await mkdir(lockPath);
        await writeFile(join(lockPath, 'holder.json'), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
        await expect(transition(taskId, 'plan', actor, { root })).rejects.toThrow(/already has a state transition in progress/);

        // One older than the bound is abandoned: the process that took it is gone, and obeying it would leave the task
        // permanently unusable.
        const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        await writeFile(join(lockPath, 'holder.json'), `${JSON.stringify({ pid: 999_999, at: longAgo })}\n`);
        const state = await transition(taskId, 'plan', actor, { root });
        expect(state.phase).toBe('plan');
        // And the lock is gone afterwards, so the next transition is not blocked by the steal.
        await expect(transition(taskId, 'implement', actor, { root })).resolves.toMatchObject({ phase: 'implement' });
    });

    it('serializes concurrent transitions for the same task', async () => {
        const root = await tempRoot();
        const task = await createTask({
            root,
            id: 'task-race',
            title: 'Serialize concurrent transitions',
            acceptance: [{ id: 'AC-1', statement: 'Only one transition wins.' }],
        });

        const results = await Promise.allSettled([
            transition(task.id, 'plan', actor, { root }),
            transition(task.id, 'plan', actor, { root }),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    });

    it('rejects task ids that would escape the .kata task directory', async () => {
        const root = await tempRoot();

        await expect(
            createTask({
                root,
                id: '../escape',
                title: 'Path traversal task',
                acceptance: [{ id: 'AC-1', statement: 'Task ids are safe.' }],
            }),
        ).rejects.toThrow(/task id/i);

        await expect(
            createTask({
                root,
                id: 'nested/task',
                title: 'Nested path task',
                acceptance: [{ id: 'AC-1', statement: 'Task ids are safe.' }],
            }),
        ).rejects.toThrow(/task id/i);
    });

    it('requires stable acceptance ids before entering implement', async () => {
        const root = await tempRoot();
        const task = await createTask({
            root,
            id: 'task-no-acceptance',
            title: 'Acceptance gated implementation',
            acceptance: [{ statement: 'This criterion has no stable id yet.' }],
        });

        await transition(task.id, 'plan', actor, { root });

        await expect(transition(task.id, 'implement', actor, { root })).rejects.toThrow(/acceptance id/i);
    });

    it('requires hard evidence, reviewer clearance, and judge pass before distill', async () => {
        const root = await tempRoot();
        const task = await createTask({
            root,
            id: 'task-distill-gates',
            title: 'Distill only after quality gates',
            acceptance: [{ id: 'AC-1', statement: 'Distill waits for evidence, reviewer, and judge.' }],
        });

        for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
            await transition(task.id, phase, actor, { root });
        }

        await expect(transition(task.id, 'distill', actor, { root })).rejects.toThrow(/evidence.*reviewer.*judge/i);

        await writePassingQualityGates(root, task.id);

        await expect(transition(task.id, 'distill', actor, { root })).resolves.toMatchObject({ phase: 'distill' });
    });

    it('rejects stale judge pass even when fresh hard evidence is present', async () => {
        const root = await tempRoot();
        const task = await createTask({
            root,
            id: 'task-stale-judge',
            title: 'Judge pass is tied to current evidence',
            acceptance: [{ id: 'AC-1', statement: 'Judge pass must match current diff.' }],
        });

        for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
            await transition(task.id, phase, actor, { root });
        }
        await writePassingQualityGates(root, task.id, { judgeDiffHash: 'a'.repeat(64) });

        await expect(transition(task.id, 'distill', actor, { root })).rejects.toThrow(/judge/i);
    });

    it('allows Archive gates to consume one current revision despite unrelated workspace drift', async () => {
        const root = await tempRoot();
        await writeFile(join(root, 'owned.txt'), 'sealed\n', 'utf8');
        const task = await createTask({
            root,
            id: 'task-revision-gates',
            title: 'Revision gates ignore unrelated drift',
            acceptance: [{ id: 'AC-1', statement: 'One revision owns the gate chain.' }],
        });
        // The task's declaration and the revision's must agree, or the new third state (`declaration-moved`) fires and the case
        // would be measuring that instead of the drift it is about. The task defaulted to `tasks/<id>`; the revision names a
        // real file, so the declaration is corrected to match — which is the shape a change actually has.
        await mutateTaskArtefact(root, task.id, taskPath(root, task.id), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, ownedPaths: ['owned.txt'] }, null, 2)}\n`;
        });
        const revision = await createTaskRevision({ root, taskId: task.id, ownedPaths: ['owned.txt'] });
        for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
            await transition(task.id, phase, actor, { root });
        }
        const diffHash = await computeDiffHash(root);
        await writeFile(join(root, `.kata/evidence/${task.id}-hard.json`), `${JSON.stringify({
            id: `${task.id}-hard`, taskId: task.id, kind: 'test', command: 'vitest run', exitCode: 0,
            startedAt: '2026-07-14T00:00:00.000Z', finishedAt: '2026-07-14T00:00:01.000Z', diffHash,
            revisionId: revision.id, scope: { paths: revision.ownedPaths, hash: revision.manifestHash },
        }, null, 2)}\n`);
        await writeFile(join(root, `.kata/tasks/${task.id}/review.json`), `${JSON.stringify({ revisionId: revision.id, findings: [], status: 'approved', reviewEvidence: 'Fixture simulates explicit reviewer approval.' }, null, 2)}\n`);
        await writeFile(join(root, `.kata/tasks/${task.id}/judge.json`), `${JSON.stringify({
            taskId: task.id, result: 'PASS', diffHash, revisionId: revision.id,
            acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: [`${task.id}-hard`] }], evidenceIds: [`${task.id}-hard`],
        }, null, 2)}\n`);
        await writeFile(join(root, 'unrelated.txt'), 'another task changed\n', 'utf8');

        await expect(transition(task.id, 'distill', actor, { root })).resolves.toMatchObject({ phase: 'distill' });
    });

});

async function writePassingQualityGates(
    root: string,
    taskId: string,
    options: { judgeDiffHash?: string } = {},
): Promise<void> {
    const diffHash = await computeDiffHash(root);
    await writeFile(
        join(root, `.kata/evidence/${taskId}-hard.json`),
        `${JSON.stringify(
            {
                id: `${taskId}-hard`,
                taskId,
                kind: 'test',
                command: 'vitest run',
                exitCode: 0,
                startedAt: '2026-07-11T00:00:00.000Z',
                finishedAt: '2026-07-11T00:00:01.000Z',
                diffHash,
            },
            null,
            2,
        )}\n`,
    );
    await writeFile(
        join(root, `.kata/tasks/${taskId}/review.json`),
        `${JSON.stringify({ findings: [], status: 'approved', reviewEvidence: 'Fixture simulates explicit reviewer approval.' }, null, 2)}\n`,
    );
    await writeFile(
        join(root, `.kata/tasks/${taskId}/judge.json`),
        `${JSON.stringify(
            {
                taskId,
                result: 'PASS',
                diffHash: options.judgeDiffHash ?? diffHash,
                acceptance: [{ id: 'AC-1', result: 'PASS' }],
                evidenceIds: [`${taskId}-hard`],
            },
            null,
            2,
        )}\n`,
    );
}
