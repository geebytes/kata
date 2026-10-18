import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { addKataRelation } from '../../src/core/relations.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { declareCorrectiveAction, normaliseClassKey, ownedClassRecurrences } from '../../src/workflow/corrective-action.js';
import { recordDependencyReturn } from '../../src/workflow/task-dependency.js';
import { readKataRelations } from '../../src/core/relations.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';

/**
 * **A discharged class is falsifiable.**
 *
 * The in-change form of this already exists: a class whose declared repair did not hold routes to a person instead of
 * another repair (`escalate_declared_repair_did_not_hold`). The corrective action is the same fact one layer out — the
 * declaration lives in another task, this change depends on it, and this change's own rounds found the class again. The
 * next move belongs to the class's owner, because repairing it here is how one class gets paid for twice (measured: five
 * rounds, three classes, three sites).
 *
 * Two things are held here: the matching is honest about its fold, and the route sits below the dependency route, so a task
 * that is still blocked hears "blocked" rather than a decision it is not yet entitled to.
 */

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

function obligation(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        states: ['no record', 'record present'],
        sourceOfTruth: 'src/workflow/task-dependency.ts#decideTaskDependencies',
        inventory: ['src/workflow/task-dependency.ts the reader'],
        invariant: 'every consumer asks decideTaskDependencies',
        repairSurface: ['src/workflow/task-dependency.ts'],
        effectivenessTest: 'tests/unit/a-blocked-task-cannot-cross-its-gate.test.ts',
        ifRecursAgain: 'rewrite_mechanism',
        ...over,
    };
}

async function fixture(name: string, options: { rounds?: Array<{ at: string; class: string }>; certifyCorrective?: boolean } = {}): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-owned-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/a.ts', 'a v1\n');
    for (const id of ['delivery', 'corrective']) {
        await createTask({ root, id, title: id, acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    }
    write(root, '.kata/tasks/delivery/current-state.json', `${JSON.stringify({
        taskId: 'delivery', phase: 'review', actor: { id: 'kata-cli', role: 'reviewer' }, updatedAt: '2026-01-01T00:00:00.000Z',
    })}\n`);
    if (options.rounds !== undefined) {
        write(root, '.kata/tasks/delivery/review-rounds.jsonl', `${options.rounds
            .map((round, index) => JSON.stringify({
                at: round.at,
                revisionId: 'revision-d1',
                blockingIds: [`f${index}`],
                blockingCount: 1,
                findings: [{ id: `f${index}`, severity: 'blocking', class: round.class }],
            }))
            .join('\n')}\n`);
    }
    await declareCorrectiveAction({
        root, taskId: 'corrective', classKey: 'one-fact-derived-twice', sourceChangeId: 'delivery', owner: 'the-owner', obligation: obligation(),
    });
    await addKataRelation({ root, from: { type: 'task', id: 'delivery' }, to: { type: 'task', id: 'corrective' }, type: 'blocked_by', reason: 'the class' });
    if (options.certifyCorrective) {
        const { revision } = await createTaskRevisionIfChanged({ root, taskId: 'corrective', ownedPaths: ['src/a.ts'] });
        // The corrective action's own review as well: the return gate reads the certification it actually has.
        write(root, '.kata/tasks/corrective/review.json', `${JSON.stringify({
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            reviewedRevisionId: revision.id,
            recordedAt: '2026-01-01T00:00:00.000Z',
            reviewEvidence: 'the independent round this corrective action was accepted on',
            findings: [],
            status: 'approved',
        })}\n`);
        write(root, '.kata/tasks/corrective/judge.json', `${JSON.stringify({
            taskId: 'corrective', result: 'PASS', revisionId: revision.id, acceptance: [{ id: 'AC-1', result: 'PASS' }],
        })}\n`);
    }
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('matching an owned class against what the rounds recorded', () => {
    it('folds case and separators, and prints the spelling it matched', () => {
        expect(normaliseClassKey(' Instrument_Unsound ')).toBe('instrument-unsound');
        const found = ownedClassRecurrences({
            owned: [{ taskId: 'corrective', classKey: 'Instrument_Unsound', owner: 'the-owner' }],
            classes: [{ class: 'instrument-unsound', rounds: ['2026-01-01T00:00:00.000Z'], findings: ['f1'] }],
        });
        expect(found).toHaveLength(1);
        expect(found[0]?.ownerTaskId).toBe('corrective');
        expect(found[0]?.recordedAs).toBe('instrument-unsound');
    });

    it('reports nothing when the names differ beyond the fold, which is a missed signal rather than a wrong owner', () => {
        const found = ownedClassRecurrences({
            owned: [{ taskId: 'corrective', classKey: 'one-fact-derived-twice', owner: 'the-owner' }],
            classes: [{ class: 'derived-twice', rounds: [], findings: [] }],
        });
        expect(found).toEqual([]);
    });
});

describe('a class its corrective action owns is not repaired here again', () => {
    it('routes to the dispatcher with the owner named, once the class recurs in this change', async () => {
        const root = await fixture('recurs', {
            certifyCorrective: true,
            // **Two rounds, because one occurrence is not a recurrence.** The class reader requires the class in more than
            // one round — which is the fact being asked about: the class *came back*.
            rounds: [
                { at: '2026-01-01T00:00:00.000Z', class: 'one-fact-derived-twice' },
                { at: '2026-01-02T00:00:00.000Z', class: 'one-fact-derived-twice' },
            ],
        });
        // **The dependency has to have returned first.** This route is the fact that the class recurred *after* the
        // corrective action was integrated and this change re-validated against it; while the corrective work is still
        // outstanding the dependency route owns the answer, which the next case holds.
        const relationId = (await readKataRelations(root)).relations.find((relation) => relation.from.id === 'delivery')?.id as string;
        await recordDependencyReturn({ root, taskId: 'delivery', relationId });

        const upstream = await readUpstreamSummary(root, 'delivery');
        expect(upstream.taskDependency?.state).toBe('ready_to_revalidate');
        expect(upstream.correctiveActionRecurrence?.[0]?.ownerTaskId).toBe('corrective');
        expect(upstream.correctiveActionRecurrence?.[0]?.owner).toBe('the-owner');
        expect(upstream.correctiveActionRecurrence?.[0]?.findings).toEqual(['f0', 'f1']);

        const suggestion = suggestCandidateAction('review', upstream);
        expect(suggestion.reason).toBe('escalate_corrective_action_did_not_hold');
        expect(suggestion.nextSkill).toBe('/kata');
    });

    it('publishes nothing when the class in the rounds is a different one', async () => {
        const root = await fixture('other-class', {
            certifyCorrective: true,
            rounds: [
                { at: '2026-01-01T00:00:00.000Z', class: 'contract-semantics' },
                { at: '2026-01-02T00:00:00.000Z', class: 'contract-semantics' },
            ],
        });
        const upstream = await readUpstreamSummary(root, 'delivery');
        expect(upstream.correctiveActionRecurrence).toBeUndefined();
        expect(suggestCandidateAction('review', upstream).reason).not.toBe('escalate_corrective_action_did_not_hold');
    });

    it('publishes nothing when the change depends on no corrective action', async () => {
        const root = await fixture('no-edge');
        const upstream = await readUpstreamSummary(root, 'delivery');
        expect(upstream.correctiveActionRecurrence).toBeUndefined();
    });

    it('lets the dependency itself speak first, so a still-blocked task hears "blocked" rather than a decision', async () => {
        // The corrective task is certified but nothing has returned it, so this change is `pending` — and the class in its
        // rounds is the one the corrective action owns. The dependency route must win: it is the fact that stops the task.
        const root = await fixture('blocked-first', {
            rounds: [
                { at: '2026-01-01T00:00:00.000Z', class: 'one-fact-derived-twice' },
                { at: '2026-01-02T00:00:00.000Z', class: 'one-fact-derived-twice' },
            ],
        });
        const upstream = await readUpstreamSummary(root, 'delivery');
        expect(upstream.taskDependency?.state).toBe('pending');
        expect(upstream.correctiveActionRecurrence?.[0]?.ownerTaskId).toBe('corrective');
        expect(suggestCandidateAction('review', upstream).reason).toBe('blocked_by_unreturned_dependency');
    });
});
