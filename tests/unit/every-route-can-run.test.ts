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
    /** Move the content after the seal, so the sealed revision no longer describes the tree and a repair is authorised. */
    drifted?: boolean;
    /** A recorded verify FAIL whose failed criteria are repairable, which is what authorises a repair entry. */
    verify?: { result: string; acceptance: Array<{ id: string; result: string; repairScope?: string }> };
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
    if (state.drifted) {
        // A repair entry that is **authorised** is the state where the defect this case exists for shows up: the entry
        // returns a value, and a build that throws there is a route that cannot be taken. Without a state that reaches the
        // authorised path the case only ever exercised the denials.
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n');
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    }
    if (state.verify) {
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'verify.json'),
            `${JSON.stringify({ taskId, revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, result: state.verify.result, acceptance: state.verify.acceptance })}\n`,
        );
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

/**
 * **Every skill the router can name**, mapped to the command that runs it.
 *
 * The previous version had five entries and skipped the rest with `if (!command) return;` — so a pass meant "the routes I
 * happened to map can run", and an independent review measured that `/kata-wiki-enrich` (`resolve_wiki_closure`) and
 * `/kata-archive` (`archive_judged_change`) were never dispatched while the case reported success. The map is exhaustive
 * now, and an unmapped skill fails the case rather than leaving the loop.
 */
const COMMAND_FOR_SKILL: Record<string, 'design' | 'build' | 'verify' | 'review' | 'judge' | null> = {
    '/kata-design': 'design',
    '/kata-build': 'build',
    '/kata-verify': 'verify',
    '/kata-review': 'review',
    '/kata-judge': 'judge',
    // Neither of these is a workflow command: the wiki closure runs through the `wiki` family and the archive through
    // `kata-cli archive`, and both are covered below rather than left out of the map silently.
    '/kata-wiki-enrich': null,
    '/kata-archive': null,
};

/** The skills that name a command outside `runCommand`'s surface, each with the case that covers it instead. */
const OUTSIDE_THE_WORKFLOW_COMMANDS = new Set(['/kata-wiki-enrich', '/kata-archive']);

describe('every route the dispatcher can return names a command that runs', () => {
    const states: State[] = [
        { name: 'intake', phase: 'intake' },
        { name: 'plan', phase: 'plan' },
        { name: 'implement', phase: 'implement' },
        { name: 'hardVerify with a healthy pointer', phase: 'hardVerify' },
        { name: 'hardVerify with a corrupted pointer', phase: 'hardVerify', corruptPointer: true },
        { name: 'hardVerify whose revision the tree has moved past', phase: 'hardVerify', drifted: true },
        {
            name: 'hardVerify with a repairable verify FAIL',
            phase: 'hardVerify',
            verify: { result: 'FAIL', acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'insufficient_evidence_level' }] },
        },
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

            // **No silent skip.** A skill the map does not name is a route this case would have stopped examining without
            // saying so, which is the weakness the review measured; it fails instead.
            expect(Object.keys(COMMAND_FOR_SKILL), `unmapped skill: ${action.nextSkill}`).toContain(action.nextSkill);
            const command = COMMAND_FOR_SKILL[action.nextSkill];
            if (!command) {
                // Named rather than skipped: these two routes are covered by the case below, and a new skill that lands
                // here without being named there fails that case.
                expect([action.nextSkill, OUTSIDE_THE_WORKFLOW_COMMANDS.has(action.nextSkill)]).toEqual([action.nextSkill, true]);
                return;
            }

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

describe('the two routes that are not workflow commands answer too', () => {
    it('runs the command each of them advertises, in the state that advertises it', async () => {
        const { runWikiCommand } = await import('../../src/cli/wiki.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-route-outside-'));
        roots.push(root);
        await mkdir(join(root, '.kata', 'tasks', 'route-outside'), { recursive: true });
        // `/kata-wiki-enrich` advertises `kata-cli wiki closure …` (the wiki family, not `runCommand`), and that command has
        // to answer on a task whose wiki store does not exist yet — `wiki init` is the skill's prerequisite, not the
        // route's. Measured while writing this: the advertised command answers, and a *different* verb of the same family
        // (`wiki orient`) throws `ENOENT … .llmwiki/SCHEMA.md`. That is a rough edge in the family and not this route, so
        // the case drives what the route names.
        const closure = await runWikiCommand([
            'closure', '--task', 'route-outside', '--decision', 'not_applicable', '--reason', 'route probe', '--root', root,
        ]).catch((error: Error) => {
            throw new Error(`the wiki closure route dispatched a command that threw: ${error.message}`);
        });
        expect(closure).toMatchObject({ command: 'wiki closure' });
        // `/kata-archive` names a workflow command, driven here with a task that really is in `judge` — the state the
        // route is returned from — so it must answer rather than throw. (A *nonexistent* task id makes several commands
        // throw a raw ENOENT; that is a separate rough edge, recorded in the design doc rather than asserted here, because
        // a route never names a task that does not exist.)
        const taskId = 'route-outside-archive';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'task.json'),
            `${JSON.stringify({ id: taskId, title: 'T', phase: 'judge', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
        );
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'current-state.json'),
            `${JSON.stringify({ taskId, phase: 'judge', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: NOW })}\n`,
        );
        const archive = await runCommand('archive', taskId, root).catch((error: Error) => {
            throw new Error(`the archive route dispatched a command that threw: ${error.message}`);
        });
        expect(typeof archive.success).toBe('boolean');
        expect(archive.command).toBe('archive');
    });
});
