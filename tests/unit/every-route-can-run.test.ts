import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A route the dispatcher can return must name a command that runs.**
 *
 * The counterexample is measured: with a corrupted pointer at `hardVerify`, the router answered
 * `currentRevisionUnreadable`, dispatched `/kata-verify`, and `verify` then threw *after* verifying everything and
 * *before* writing its verdict — discarding the run and handing the operator no envelope at all, from the very command
 * the router had just recommended. The same shape was in `build`: `repair_unreadable_current_revision` points at
 * `/kata-build`, and build refused by throwing.
 *
 * The rule this pins: **a CLI command refuses with a value, not with an exception.** A thrown `Error` carries no
 * `command`, no `phase` and no diagnostics, so nothing upstream can report it — and a router whose recommendation can
 * throw is a recommendation that cannot be followed.
 *
 * The states below are the ones the router can actually produce; each is dispatched and each command must answer.
 */
const NOW = '2026-09-29T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Phase = 'intake' | 'plan' | 'implement' | 'hardVerify' | 'review' | 'judge' | 'distill';

interface State {
    name: string;
    phase: Phase;
    /** The task's recorded phase, which the command reads separately from `current-state.json`. */
    taskPhase?: Phase;
    review?: { status: string; reviewEvidence?: string; findings?: unknown[] };
    judge?: { result: string };
    corruptPointer?: boolean;
    noPointer?: boolean;
}

async function construct(state: State): Promise<{ root: string; taskId: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-route-'));
    roots.push(root);
    const taskId = 'route-can-run';
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({
            id: taskId, title: 'T', phase: state.taskPhase ?? state.phase,
            acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'],
            acceptanceMatrix: {
                version: 1,
                rows: [{
                    acceptanceId: 'AC-1', implementationPaths: ['subject.ts'], testPaths: ['subject.ts'],
                    evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'subject.ts' }],
                    verificationLevel: 'unit',
                }],
            },
            createdAt: NOW, updatedAt: NOW,
        })}\n`,
    );
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'current-state.json'),
        `${JSON.stringify({ taskId, phase: state.phase, actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: NOW })}\n`,
    );
    if (state.corruptPointer) {
        await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'not json\n');
    }
    if (state.noPointer) {
        await rm(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), { force: true });
    }
    if (state.review) {
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'review.json'),
            `${JSON.stringify({ revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, findings: [], ...state.review })}\n`,
        );
    }
    if (state.judge) {
        await writeFile(join(root, '.kata', 'tasks', taskId, 'judge.json'), `${JSON.stringify(state.judge)}\n`);
    }
    return { root, taskId };
}

const COMMAND_FOR_SKILL: Record<string, 'design' | 'build' | 'verify' | 'review' | 'judge'> = {
    '/kata-design': 'design',
    '/kata-build': 'build',
    '/kata-verify': 'verify',
    '/kata-review': 'review',
    '/kata-judge': 'judge',
};

describe('every route the dispatcher can return names a command that runs', () => {
    const states: State[] = [
        { name: 'intake', phase: 'intake' },
        { name: 'plan', phase: 'plan' },
        { name: 'implement', phase: 'implement' },
        { name: 'hardVerify with a healthy pointer', phase: 'hardVerify' },
        { name: 'hardVerify with a corrupted pointer', phase: 'hardVerify', corruptPointer: true },
        { name: 'review with no review recorded', phase: 'review' },
        { name: 'review with a pending review', phase: 'review', review: { status: 'pending' } },
        { name: 'review with an approved review', phase: 'review', review: { status: 'approved', reviewEvidence: 'reviewed' } },
        { name: 'judge with a pass recorded', phase: 'judge', judge: { result: 'PASS' } },
        { name: 'judge with a fail recorded', phase: 'judge', judge: { result: 'FAIL' } },
        { name: 'review with a corrupted pointer', phase: 'review', corruptPointer: true },
        { name: 'distill', phase: 'distill' },
    ];

    for (const state of states) {
        it(`runs the command its route names: ${state.name}`, async () => {
            const { root, taskId } = await construct(state);
            const upstream = await readUpstreamSummary(root, taskId);
            const action = suggestCandidateAction(state.phase, upstream);

            const command = COMMAND_FOR_SKILL[action.nextSkill];
            if (!command) return; // The dispatcher's own route runs nothing.

            // The assertion is on *answering*: a throw here is the defect, whatever the answer says.
            const result = await runCommand(command, taskId, root, { confirmHostModel: true }).catch((error: Error) => {
                throw new Error(
                    `Route ${action.reason} → ${action.nextSkill} dispatched a command that threw: ${error.message}`,
                );
            });
            expect(result.command).toBe(command);
            expect(typeof result.success).toBe('boolean');
        });
    }
});