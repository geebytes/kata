import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { collectReviewPreflight } from '../../src/workflow/review-preflight.js';
import { runWorkflowCommand } from '../../src/cli/workflow.js';

/**
 * **The brief is checked before the reviewer is spent, not after.**
 *
 * Measured: a round was dispatched, read for nineteen minutes and answered, and only then refused — because the result did
 * not echo the `requestId` and did not answer for every finding in the batch it was handed. The reviewer's work was
 * correct; the brief it received was incomplete, and nothing before the dispatch could say so. Every field the recorder
 * demands is already known at dispatch time, because the recorder reads it from the same persisted document.
 *
 * So the check has two outputs and neither is a new gate: the blockers that make a dispatch pointless, and the
 * machine-readable list of what must be handed over and echoed — derived, so an author copies it instead of remembering it.
 */

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

/**
 * The brief is built from the revision the fixture actually sealed, so a test cannot accidentally name one that does not
 * exist — the self-reference `briefFor(revisionId)` inside the call that produces `revisionId` was a real mistake here
 * before the builder form.
 */
async function fixture(name: string, options: { brief?: (revisionId: string) => unknown; phase?: string; moveTree?: boolean } = {}): Promise<{ root: string; revisionId: string }> {
    const root = mkdtempSync(join(tmpdir(), `kata-preflight-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/a.ts', 'a v1\n');
    await createTask({
        root,
        id: 'held',
        title: 'held',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    const { revision } = await createTaskRevisionIfChanged({ root, taskId: 'held', ownedPaths: ['src/a.ts'] });
    write(root, '.kata/tasks/held/current-state.json', `${JSON.stringify({
        taskId: 'held',
        phase: options.phase ?? 'review',
        actor: { id: 'kata-cli', role: 'dispatcher' },
        updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    if (options.moveTree) write(root, 'src/a.ts', 'a moved after the seal\n');
    if (options.brief !== undefined) {
        write(root, '.kata/tasks/held/review-request.json', `${JSON.stringify(options.brief(revision.id), null, 2)}\n`);
    }
    return { root, revisionId: revision.id };
}

function briefFor(revisionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: 1,
        changeId: 'held',
        reviewKind: 'certification',
        requestId: 'request-abc',
        subjectRevision: revisionId,
        probes: [],
        reviewPackage: { declaration: { ownedPaths: ['src/a.ts'] } },
        ...over,
    };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the pre-dispatch preflight', () => {
    it('reports the missing brief as a step not yet taken, not as a broken one', async () => {
        const { root } = await fixture('no-brief');
        const preflight = await collectReviewPreflight({ root, taskId: 'held' });
        expect(preflight.ok).toBe(false);
        expect(preflight.briefState).toBe('absent');
        expect(preflight.blockers[0]?.code).toBe('brief_missing');
        expect(preflight.blockers[0]?.road).toBe('kata-cli ledger run --change held');
    });

    it('hands over what the result must echo, including every batch finding the round owes a verdict for', async () => {
        const { root } = await fixture('handoff', {
            brief: (id) => briefFor(id, {
                reviewKind: 'focused_followup',
                repairBatch: { findings: [{ id: 'gate-r10-F1' }, { id: 'gate-r10-F2' }] },
                probes: [{ id: 'p1', claimId: 'c1', command: 'npm test' }],
            }),
        });
        const preflight = await collectReviewPreflight({ root, taskId: 'held' });
        expect(preflight.ok).toBe(true);
        expect(preflight.handoff?.mustEcho).toContain('requestId');
        expect(preflight.handoff?.mustEcho).toContain('reviewKind');
        // The measured waste: a follow-up that was never told which findings it had to answer for.
        expect(preflight.handoff?.batchClosureIds).toEqual(['gate-r10-F1', 'gate-r10-F2']);
        expect(preflight.handoff?.probeCount).toBe(1);
    });

    it('refuses a brief that answers a revision the task has moved past', async () => {
        const { root } = await fixture('stale-brief', { brief: () => briefFor('revision-something-else') });
        const preflight = await collectReviewPreflight({ root, taskId: 'held' });
        expect(preflight.blockers.map((entry) => entry.code)).toContain('brief_answers_another_revision');
        expect(preflight.blockers.find((entry) => entry.code === 'brief_answers_another_revision')?.road).toBe('kata-cli ledger run --change held');
    });

    it('refuses a follow-up with no batch, and a brief whose declared surface does not exist', async () => {
        const { root } = await fixture('followup-without-batch', {
            brief: (id) => briefFor(id, { reviewKind: 'focused_followup', reviewPackage: { declaration: { ownedPaths: ['src/gone.ts'] } } }),
        });
        const codes = (await collectReviewPreflight({ root, taskId: 'held' })).blockers.map((entry) => entry.code);
        expect(codes).toContain('followup_without_batch');
        expect(codes).toContain('brief_names_missing_paths');
    });

    it('refuses a tree that is no longer the frozen revision, because the round would read content nobody sealed', async () => {
        const { root } = await fixture('moved-tree', { brief: (id) => briefFor(id), moveTree: true });
        const preflight = await collectReviewPreflight({ root, taskId: 'held' });
        expect(preflight.blockers.map((entry) => entry.code)).toContain('working_tree_moved');
        expect(preflight.blockers.find((entry) => entry.code === 'working_tree_moved')?.road).toBe('kata-cli build --change held --seal');
    });

    it('does not try to review a task that is not at a reviewable phase', async () => {
        const { root } = await fixture('wrong-phase', { phase: 'implement' });
        const codes = (await collectReviewPreflight({ root, taskId: 'held' })).blockers.map((entry) => entry.code);
        expect(codes).toContain('phase_not_reviewable');
    });
});

describe('the entry refuses a brief it would waste a reviewer on, and spends no gate doing it', () => {
    it('refuses before the boundary is consumed when a persisted brief cannot be dispatched', async () => {
        const { root } = await fixture('entry-refuses', { brief: () => briefFor('revision-something-else') });
        const refused = await runWorkflowCommand('review', 'held', root, undefined, ['review'])
            .catch((error: Error) => error.message);
        expect(String(refused)).toMatch(/pre-dispatch problem/u);
        expect(String(refused)).toMatch(/brief_answers_another_revision/u);
        // The road, not a dead end: the refusal names the command that rebuilds the brief.
        expect(String(refused)).toMatch(/kata-cli ledger run --change held/u);
    });

    it('leaves the phase entry alone when no brief exists yet, so the ladder still runs', async () => {
        // `verify` → `gate approve` → `review` is the sequence the CLI prints, and at that moment no brief has been built:
        // refusing the entry here would break the flow rather than protect it.
        const { root } = await fixture('entry-open');
        const refused = await runWorkflowCommand('review', 'held', root, undefined, ['review'])
            .catch((error: Error) => error.message);
        expect(String(refused)).not.toMatch(/pre-dispatch problem/u);
        expect(String(refused)).toMatch(/explicit user choice/u);
    });

    it('reports the same derivation to an author who asks for it, without refusing anything', async () => {
        const { root } = await fixture('author-asks', { brief: (id) => briefFor(id) });
        const report = await runWorkflowCommand('review', 'held', root, undefined, ['review', '--preflight']);
        expect(report.success).toBe(true);
        expect((report.handoff as { requestId?: string }).requestId).toBe('request-abc');
    });
});
