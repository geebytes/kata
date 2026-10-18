import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { addKataRelation } from '../../src/core/relations.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import {
    decideTaskDependencies,
    dependencyRefusal,
    readTaskDependency,
    recordDependencyReturn,
    summarizeTaskDependency,
    type CorrectiveFacts,
    type DependencyEdge,
} from '../../src/workflow/task-dependency.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { runGateCommand } from '../../src/cli/workflow.js';
import { runDependencyCommand } from '../../src/cli/dependency.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { runLocalStatusCommand } from '../../src/cli/tasks.js';

/**
 * **A task blocked by another task may not certify itself past it.**
 *
 * The fact this file is about is the one the repository's own defect class (`one-fact-derived-twice`) is most likely to
 * produce, because a dependency is the only workflow fact that spans two tasks: the graph knows the edge, the corrective
 * task knows whether it was certified, the tree knows whether the fix is present, and the dependent task knows whether it
 * has been re-validated against that fix. Before this change, `blocked_by` was a comment: `relations add` wrote it and no
 * governed entry read it, so `kata-cli build --seal` succeeded on a task whose blocker had never been written at all.
 *
 * The tests below are in two layers on purpose. The pure decision is posed with every state a repository would have to be
 * built to reach (`decideTaskDependencies`), and the repository-level tests drive the *commands* — seal, `gate approve`,
 * `dependency record` — because a decision nothing asks is exactly the defect being repaired.
 */

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

async function task(root: string, id: string, ownedPaths: string[]): Promise<void> {
    await createTask({
        root,
        id,
        title: id,
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths,
    });
    for (const path of ownedPaths) write(root, path, `${id} v1\n`);
}

/** A corrective task that has been independently certified: an accepted revision and a Judge pass bound to it. */
async function certify(root: string, id: string, ownedPaths: string[], options: { review?: boolean } = {}): Promise<string> {
    const { revision } = await createTaskRevisionIfChanged({ root, taskId: id, ownedPaths });
    write(root, `.kata/tasks/${id}/judge.json`, `${JSON.stringify({
        taskId: id,
        result: 'PASS',
        revisionId: revision.id,
        acceptance: [{ id: 'AC-1', result: 'PASS' }],
    }, null, 2)}\n`);
    // **And the review, because a judged task is not yet an accepted one.** The gate reads both, so a fixture that wrote
    // only the judge record would be modelling a state the workflow cannot reach: `kata-cli review` is what precedes it.
    // The one case that needs that unreachable state asks for it explicitly.
    if (options.review === false) return revision.id;
    write(root, `.kata/tasks/${id}/review.json`, `${JSON.stringify({
        revisionId: revision.id,
        manifestHash: revision.manifestHash,
        reviewedRevisionId: revision.id,
        recordedAt: '2026-01-01T00:00:00.000Z',
        reviewEvidence: 'the independent round this corrective action was accepted on',
        findings: [],
        status: 'approved',
    }, null, 2)}\n`);
    return revision.id;
}

async function fixture(name: string, options: { certifyCorrective?: boolean; reviewCorrective?: boolean } = {}): Promise<{ root: string; relationId: string }> {
    const root = mkdtempSync(join(tmpdir(), `kata-dependency-${name}-`));
    roots.push(root);
    await initLayout(root);
    await task(root, 'dependent', ['src/dependent.ts']);
    await task(root, 'corrective', ['src/corrective.ts']);
    if (options.certifyCorrective) await certify(root, 'corrective', ['src/corrective.ts'], { review: options.reviewCorrective ?? true });
    const graph = await addKataRelation({
        root,
        from: { type: 'task', id: 'dependent' },
        to: { type: 'task', id: 'corrective' },
        type: 'blocked_by',
        reason: 'the corrective action fixes the mechanism this task depends on',
    });
    const relation = graph.relations.find((entry) => entry.from.id === 'dependent' && entry.to.id === 'corrective');
    return { root, relationId: relation?.id ?? '' };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const edge: DependencyEdge = { relationId: 'rel-1', relationType: 'blocked_by', correctiveTaskId: 'corrective' };
const certified: CorrectiveFacts = {
    taskId: 'corrective',
    taskReadState: 'usable',
    phase: 'judge',
    revisionReadState: 'current',
    revisionId: 'rev-c',
    judgedPass: true,
    reviewedApproved: true,
    touchesCertificationMachinery: [],
    integratedContentHash: 'hash-1',
};
const recordedReturn = {
    relationId: 'rel-1',
    correctiveTaskId: 'corrective',
    correctiveRevisionId: 'rev-c',
    integratedContentHash: 'hash-1',
    subjectRevisionId: 'rev-d',
    recordedAt: '2026-01-01T00:00:00.000Z',
};

describe('the one decision about a blocking edge', () => {
    it('is absent when no edge claims anything, so an edge-less task is untouched', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [],
            corrective: [certified],
            returns: [],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('absent');
        expect(dependencyRefusal(decision, 'seal')).toBeNull();
        expect(dependencyRefusal(decision, 'archive')).toBeNull();
    });

    it('is pending while the corrective task has not been independently certified', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [{ ...certified, revisionId: null, revisionReadState: 'absent', judgedPass: false }],
            returns: [],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('pending');
        expect(decision.blockers[0]?.reason).toBe('corrective_not_certified');
        // A judgement that exists but does not answer this revision is not a certification.
        const staleJudge = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [{ ...certified, judgedPass: false }],
            returns: [],
            subjectRevisionId: 'rev-d',
        });
        expect(staleJudge.state).toBe('pending');
    });

    it('is pending, with a road, while the return has not been recorded', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [certified],
            returns: [],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('pending');
        expect(decision.blockers[0]?.reason).toBe('return_not_recorded');
        expect(decision.blockers[0]?.road).toBe('kata-cli dependency record --change dependent --relation rel-1');
        expect(dependencyRefusal(decision, 'seal')?.road).toBe('kata-cli dependency record --change dependent --relation rel-1');
    });

    it('is undetermined when the corrective work moved after the return, and never folds that into pending', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [{ ...certified, revisionId: 'rev-c2' }],
            returns: [recordedReturn],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('undetermined');
        expect(decision.blockers[0]?.reason).toBe('corrective_moved_after_return');
    });

    it('is undetermined when the certified content is no longer the content this tree holds', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [{ ...certified, integratedContentHash: 'hash-2' }],
            returns: [recordedReturn],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('undetermined');
        expect(decision.blockers[0]?.reason).toBe('integration_drifted');
    });

    it('is undetermined — not absent — when a record about the edge cannot be read', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [{ ...certified, revisionReadState: 'unreadable' }],
            returns: [recordedReturn],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('undetermined');
        expect(decision.blockers[0]?.reason).toBe('corrective_record_unreadable');
    });

    it('permits the re-validation entries once returned, and still refuses judge and archive until it happens', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [certified],
            returns: [recordedReturn],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('ready_to_revalidate');
        expect(dependencyRefusal(decision, 'seal')).toBeNull();
        expect(dependencyRefusal(decision, 'verify')).toBeNull();
        expect(dependencyRefusal(decision, 'review')).toBeNull();
        expect(dependencyRefusal(decision, 'judge')?.message).toMatch(/not been re-validated/u);
        expect(dependencyRefusal(decision, 'archive')?.message).toMatch(/not been re-validated/u);
    });

    it('is revalidated once the dependent task stands at a different revision than the return was recorded against', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge],
            corrective: [certified],
            returns: [recordedReturn],
            subjectRevisionId: 'rev-d2',
        });
        expect(decision.state).toBe('revalidated');
        expect(dependencyRefusal(decision, 'judge')).toBeNull();
        expect(dependencyRefusal(decision, 'archive')).toBeNull();
    });

    it('takes the worst state over several edges, because either one blocks', () => {
        const decision = decideTaskDependencies({
            taskId: 'dependent',
            edges: [edge, { ...edge, relationId: 'rel-2', correctiveTaskId: 'other' }],
            corrective: [certified, { ...certified, taskId: 'other', revisionId: null, revisionReadState: 'absent', judgedPass: false }],
            returns: [recordedReturn],
            subjectRevisionId: 'rev-d',
        });
        expect(decision.state).toBe('pending');
        expect(decision.blockers).toHaveLength(1);
        expect(decision.blockers[0]?.correctiveTaskId).toBe('other');
    });
});

describe('a blocked task cannot certify itself past its gate', () => {
    it('refuses the seal, and the refusal names the corrective task and a road', async () => {
        const { root } = await fixture('seal-refused');
        await expect(runCommand('build', 'dependent', root, { seal: true })).rejects.toThrow(/blocked by a corrective action/u);
        await expect(runCommand('build', 'dependent', root, { seal: true })).rejects.toThrow(/corrective_not_certified/u);
        await expect(runCommand('build', 'dependent', root, { seal: true })).rejects.toThrow(/kata-cli status --change corrective/u);
    });

    it('leaves a repair entry open, because that is what produces the content the re-validation needs', async () => {
        const { root } = await fixture('repair-open');
        // `build` without `--seal` is the repair entry: it certifies nothing, so the dependency does not stop it.
        const result = await runCommand('build', 'dependent', root, { seal: false });
        expect(result.success).toBe(false);
        expect(String(result.error ?? '')).not.toMatch(/blocked by a corrective action/u);
    });

    it('refuses the trust-boundary approval in front of it, so a recorded decision cannot stand in for evidence', async () => {
        const { root } = await fixture('gate-refused');
        await expect(runGateCommand(['approve', '--task', 'dependent', '--boundary', 'review_gate', '--choice', 'continue_current'], root))
            .rejects.toThrow(/blocked by a corrective action/u);
    });

    it('refuses judge and archive while the returned dependency has not been re-validated', async () => {
        const { root, relationId } = await fixture('judge-refused', { certifyCorrective: true });
        await recordDependencyReturn({ root, taskId: 'dependent', relationId });
        await expect(runCommand('judge', 'dependent', root)).rejects.toThrow(/not been re-validated/u);
        await expect(runCommand('archive', 'dependent', root)).rejects.toThrow(/not been re-validated/u);
    });

    it('stops refusing once the dependent task re-sealed on the returned content', async () => {
        const { root, relationId } = await fixture('revalidated', { certifyCorrective: true });
        await recordDependencyReturn({ root, taskId: 'dependent', relationId });
        // The re-validation itself: the dependent task's own content moves, so its revision is no longer the one the return
        // was recorded against. Nothing here fakes a pass — the state only says the re-validation has happened.
        write(root, 'src/dependent.ts', 'dependent v2\n');
        await createTaskRevisionIfChanged({ root, taskId: 'dependent', ownedPaths: ['src/dependent.ts'] });

        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('revalidated');
        expect(dependencyRefusal(decision, 'judge')).toBeNull();
        // And the refusal is gone from the command's own entry, which is what the state is for.
        const result = await runCommand('judge', 'dependent', root);
        expect(String(result.error ?? '')).not.toMatch(/not been re-validated/u);
    });
});

describe('the writer asks the same question the gate asks', () => {
    it('refuses to record a return for a corrective task that is not independently certified', async () => {
        const { root, relationId } = await fixture('uncertified-write');
        await expect(recordDependencyReturn({ root, taskId: 'dependent', relationId }))
            .rejects.toThrow(/no readable accepted revision/u);
    });

    it('records the return a human authorized, and then reports the road that re-validation needs', async () => {
        const { root, relationId } = await fixture('record-road', { certifyCorrective: true });
        const recorded = await runDependencyCommand(['record', '--change', 'dependent', '--relation', relationId, '--note', 'authorized', '--root', root]);
        expect(recorded.state).toBe('ready_to_revalidate');
        expect(String(recorded.message)).toMatch(/Re-seal 'dependent'/u);

        const status = await runDependencyCommand(['status', '--change', 'dependent', '--root', root]);
        expect(status.state).toBe('ready_to_revalidate');
        expect((status.entries as Record<string, unknown>).seal).toBe('permitted');
        expect((status.entries as Record<string, { refused?: string }>).judge?.refused).toMatch(/not been re-validated/u);
    });

    it('replaces rather than appends, so one edge never has two answers', async () => {
        const { root, relationId } = await fixture('one-answer', { certifyCorrective: true });
        await recordDependencyReturn({ root, taskId: 'dependent', relationId });
        await recordDependencyReturn({ root, taskId: 'dependent', relationId, note: 'second' });
        const record = JSON.parse(readFileSync(join(root, '.kata/tasks/dependent/dependencies.json'), 'utf8')) as { returns: unknown[] };
        expect(record.returns).toHaveLength(1);
    });
});

describe('a damaged return record is not an empty one', () => {
    it('reports undetermined instead of pending, because the two have different remedies', async () => {
        const { root } = await fixture('damaged-return', { certifyCorrective: true });
        write(root, '.kata/tasks/dependent/dependencies.json', '{ "taskId": "dependent", "returns": "not-an-array" }\n');

        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('undetermined');
        expect(decision.blockers[0]?.reason).toBe('return_record_unreadable');
        const summary = summarizeTaskDependency(decision);
        expect((summary.blockers as Array<{ road: string | null }>)[0]?.road).toMatch(/dependency status/u);
    });
});

describe('a corrective action is returned only after it was independently reviewed', () => {
    it('refuses a return whose corrective action was judged but never reviewed', async () => {
        // **C's certification is its own three gates, not one of them.** The return gate used to read only `judge.json`, so a
        // task that reached a Judge PASS without an approved independent review could sign the receipt that unblocks another
        // change — which is the design's own sentence ("C 先独立认证（Verify/Review/Judge）… 不得由 C 自称'我已修好'签发自己的
        // return receipt") with one third of it missing.
        const { root, relationId } = await fixture('judged-not-reviewed', { certifyCorrective: true, reviewCorrective: false });

        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('pending');
        expect(decision.blockers[0]?.reason).toBe('corrective_not_reviewed');
        // The road names the review, because that is the step that is missing — not the judge the task already has.
        expect(decision.blockers[0]?.road).toContain('corrective');

        await expect(recordDependencyReturn({ root, taskId: 'dependent', relationId }))
            .rejects.toThrow(/independent review/u);

        // And with the review approved against C's current revision, the same return is accepted.
        const revision = JSON.parse(readFileSync(join(root, '.kata/tasks/corrective/current-revision.json'), 'utf8')) as { id: string; manifestHash: string };
        write(root, '.kata/tasks/corrective/review.json', `${JSON.stringify({
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            reviewedRevisionId: revision.id,
            recordedAt: '2026-01-02T00:00:00.000Z',
            reviewEvidence: 'the independent round the corrective action was accepted on',
            findings: [],
            status: 'approved',
        })}\n`);

        await recordDependencyReturn({ root, taskId: 'dependent', relationId });
        expect((await readTaskDependency(root, 'dependent')).state).toBe('ready_to_revalidate');
    });
});

describe('the routing prompt and the gate ask the same decision', () => {
    it('publishes the dependency on the summary the router and `status` read', async () => {
        const { root } = await fixture('published');
        const upstream = await readUpstreamSummary(root, 'dependent');

        expect(upstream.taskDependency?.state).toBe('pending');
        expect(upstream.taskDependency?.blockers[0]?.reason).toBe('corrective_not_certified');
        expect(upstream.taskDependency?.blockers[0]?.road).toBe('kata-cli status --change corrective');
        // The blocking count refuses as well, so a route that counts findings cannot read this as "nothing blocks".
        expect(upstream.blockingFindings).toBeGreaterThan(0);
        expect(upstream.reviewFindings).toBeGreaterThan(0);
    });

    it('routes the dispatcher to the road the refusal prints, and not to a repair of this task', async () => {
        const { root } = await fixture('routed');
        const upstream = await readUpstreamSummary(root, 'dependent');

        // At the phases where certification is what comes next, the dependency is the answer.
        for (const phase of ['hardVerify', 'review', 'judge']) {
            const suggestion = suggestCandidateAction(phase, upstream);
            expect(suggestion.reason).toBe('blocked_by_unreturned_dependency');
            expect(suggestion.nextSkill).toBe('/kata');
        }
    });

    it('stays out of the way while the task is still implementing, because a blocked task can still work', async () => {
        const { root } = await fixture('implement-open');
        const upstream = await readUpstreamSummary(root, 'dependent');
        const suggestion = suggestCandidateAction('implement', upstream);
        expect(suggestion.reason).not.toBe('blocked_by_unreturned_dependency');
    });

    it('reaches the operator through `status`, which is where a road is read before it is paid for', async () => {
        const { root } = await fixture('status-visible');
        const status = await runLocalStatusCommand('dependent', null, root);
        const published = status.upstream as { taskDependency?: { state?: string } };
        expect(published.taskDependency?.state).toBe('pending');
    });

    it('stops routing on the dependency once it has returned, because the entries it blocks are the re-validation', async () => {
        const { root, relationId } = await fixture('returned', { certifyCorrective: true });
        await recordDependencyReturn({ root, taskId: 'dependent', relationId });
        const upstream = await readUpstreamSummary(root, 'dependent');
        expect(upstream.taskDependency?.state).toBe('ready_to_revalidate');
        expect(suggestCandidateAction('hardVerify', upstream).reason).not.toBe('blocked_by_unreturned_dependency');

        // **And the summary must not read as "nothing blocks" while a gate refuses.** `ready_to_revalidate` has no blockers
        // and still refuses `judge`/`archive`, so the per-entry answer travels with the state — the shape this repository
        // already paid for once, when a status published `reviewFindings: 0` beside a ledger it could not read.
        const entries = upstream.taskDependency?.entries ?? {};
        expect(entries.seal).toBe('permitted');
        expect((entries.judge as { refused?: string }).refused).toMatch(/not been re-validated/u);
    });
});
