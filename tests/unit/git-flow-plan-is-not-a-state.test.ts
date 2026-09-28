import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyGitFlowPlan, inspectGitFlow, toGitFlowState, type GitCommandRunner, type GitFlowPlan } from '../../src/core/git-flow.js';
import { updateGitFlowProfile } from '../../src/core/workflow-profile.js';
import { createTask, readTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { defaultWorkflowProfile } from '../../src/core/workflow-profile.js';

/**
 * **A plan must not be persisted where a state is required.**
 *
 * `GitFlowPlan extends GitFlowState`, so TypeScript accepts a plan wherever a state is required and the extra property is
 * invisible at the type level. Measured in a downstream repository: `schemas/task.schema.json` forbids extra properties,
 * so every `git_flow` task kata created failed its own schema on the next read and `design` — the mandated next step
 * after `open` — refused a record kata had written one command earlier. The surface looked healthy the whole time, because
 * `status` and `orient` read the file without the schema.
 *
 * Three properties, and the third is the one that would have caught it:
 *
 * 1. **Every plan shape projects to a state without `command`** — including `applyGitFlowPlan`'s early return, which
 *    spread the plan and leaked it on the ordinary branch-already-current path.
 * 2. **The writer refuses what its reader rejects**, so a future call site cannot reintroduce the defect by passing the
 *    wrong argument. Delete the validation and the case below goes red.
 * 3. **A writer's output is handed to the reader.** The old tests read `task.json` with `readFile` + `JSON.parse` and
 *    asserted with `toMatchObject`, which ignores extra properties — the artefact was never handed to the reader that
 *    rejects it, which is why nothing caught this.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const runner = (responses: Record<string, { ok: boolean; stdout: string }>): GitCommandRunner =>
    (_root, args) => responses[args.join(' ')] ?? { ok: true, stdout: '' };

/** Every shape `inspectGitFlow` can return, taken from its own branches rather than written by hand. */
function everyPlan(): GitFlowPlan[] {
    return [
        // worktree dirty
        inspectGitFlow('/repo', 'sample-task', runner({ 'status --porcelain': { ok: true, stdout: ' M src/file.ts' } })),
        // nothing to do: the branch is already current — the path that was persisted as-is
        inspectGitFlow('/repo', 'sample-task', runner({ 'status --porcelain': { ok: true, stdout: '' }, 'branch --show-current': { ok: true, stdout: 'feature/sample-task' } })),
        // the branch exists and is not current
        inspectGitFlow('/repo', 'sample-task', runner({ 'status --porcelain': { ok: true, stdout: '' }, 'branch --show-current': { ok: true, stdout: 'develop' }, 'branch --list feature/sample-task': { ok: true, stdout: 'feature/sample-task' } })),
        // the branch has to be created
        inspectGitFlow('/repo', 'sample-task', runner({ 'status --porcelain': { ok: true, stdout: '' }, 'branch --show-current': { ok: true, stdout: 'develop' }, 'branch --list feature/sample-task': { ok: true, stdout: '' } })),
    ];
}

describe('a git-flow plan is never persisted as a state', () => {
    it('projects every shape inspectGitFlow can return, and the execution path’s early return too', () => {
        const plans = everyPlan();
        expect(plans.length, 'the fixture must cover the branches, or this proves nothing').toBeGreaterThan(2);
        for (const plan of plans) {
            expect(plan, 'inspectGitFlow returns a plan, which carries `command`').toHaveProperty('command');
            const state = toGitFlowState(plan);
            expect(Object.keys(state), `a plan projected for ${plan.status} kept a planning-only field`).not.toContain('command');
            // The projection keeps what the record needs, or it would be a deletion rather than a projection.
            expect(state.strategy).toBe(plan.strategy);
            expect(state.status).toBe(plan.status);
            expect(state.branch).toBe(plan.branch);
        }

        // The early return inside the executor: reached when a plan has no command to run, and it spread the plan.
        const leaked = { strategy: 'manual' as const, branch: 'feature/x', baseBranch: 'develop', status: 'active' as const, command: [] as string[] };
        expect(applyGitFlowPlan('/repo', leaked, runner({}))).not.toHaveProperty('command');
    });

    it('refuses to persist a profile this task’s own schema rejects, and writes nothing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-git-flow-profile-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'gf-task',
            title: 'Git flow task',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            workflowProfile: { ...defaultWorkflowProfile(), isolationMode: 'git_flow' },
        });
        const before = await readFile(join(root, '.kata/tasks/gf-task/task.json'), 'utf8');

        // Exactly what five of `inspectGitFlow`'s six returns carry. **This is the mutation target**: remove the validation
        // from `updateGitFlowProfile` and this call resolves instead of rejecting, and the file on disk becomes a record
        // its own reader refuses.
        await expect(updateGitFlowProfile(root, 'gf-task', {
            strategy: 'manual', branch: 'feature/gf-task', baseBranch: 'develop', status: 'active',
            ...({ command: [] } as unknown as { installation?: undefined }),
        })).rejects.toThrow(/refusing to persist a workflow profile this task's own schema rejects/);

        // Nothing was written: the refusal happens inside the lock and before the write.
        await expect(readFile(join(root, '.kata/tasks/gf-task/task.json'), 'utf8')).resolves.toBe(before);
    });

    it('hands a writer’s output to the reader that validates it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-git-flow-reader-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'gf-task',
            title: 'Git flow task',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            workflowProfile: { ...defaultWorkflowProfile(), isolationMode: 'git_flow' },
        });

        // What the persistence paths now do: project, then write.
        const plan = inspectGitFlow(root, 'gf-task', runner({ 'status --porcelain': { ok: true, stdout: '' }, 'branch --show-current': { ok: true, stdout: 'feature/gf-task' } }));
        await updateGitFlowProfile(root, 'gf-task', toGitFlowState(plan));

        // **The reader, not `JSON.parse`.** `readTask` schema-validates, and it is the call that used to refuse the file
        // kata had just written — while the old tests read the raw text and asserted with `toMatchObject`, which ignores
        // exactly the property that made it invalid.
        const stored = await readTask(root, 'gf-task');
        expect(stored.workflowProfile?.gitFlow).toMatchObject({ status: 'active' });
        expect(stored.workflowProfile?.gitFlow).not.toHaveProperty('command');
    });
});
