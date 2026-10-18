import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { readClassMetrics, readChangeMetrics, summarizePhases, summarizeRounds } from '../../src/workflow/metrics.js';
import { declareCorrectiveAction } from '../../src/workflow/corrective-action.js';
import { addKataRelation } from '../../src/core/relations.js';
import { runMetricsCommand } from '../../src/cli/metrics.js';

/**
 * **The design's inequality had no reader.**
 *
 * Route A is priced with `Σ(A_i − R_i) > C + I + M`, and every term is a count this repository already records: rounds,
 * revisions, repair entries (the phase machine's own `isRepairReturn` predicate), dependency edges, class declarations.
 * Nothing published them, so the question could only be argued — which is why the earlier report refused to quote a saving.
 *
 * These tests hold the reading to two things: the counts are exact, and **the durations are labelled as calendar time with
 * the unobservable fields named** rather than left as an implicit zero. Presenting elapsed time between recorded events as
 * effort is the substitution this repository keeps finding one layer down.
 */

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

async function fixture(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-metrics-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/a.ts', 'a v1\n');
    for (const id of ['delivery', 'corrective']) {
        await createTask({ root, id, title: id, acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    }
    return root;
}

/** The recorded shapes the reading folds: transitions, rounds and revisions, written as the pipeline writes them. */
function recordHistory(root: string, taskId: string, input: { events: Array<[string, string, string]>; rounds: Array<[string, number]> }): void {
    write(root, `.kata/tasks/${taskId}/state-events.jsonl`, `${input.events
        .map(([at, from, to]) => JSON.stringify({ taskId, at, from: from === '' ? null : from, to, actor: { id: 'kata-cli', role: 'implementer' } }))
        .join('\n')}\n`);
    write(root, `.kata/tasks/${taskId}/review-rounds.jsonl`, `${input.rounds
        // A complete round row, as the pipeline writes it: the reader's shape check refuses a row without `blockingIds`,
        // which is why a hand-made fixture that omits it reads as no rounds at all.
        .map(([at, blockingCount]) => JSON.stringify({ at, revisionId: 'revision-1', blockingIds: ['f1'], blockingCount, findings: [{ id: 'f1' }] }))
        .join('\n')}\n`);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the per-change reading', () => {
    it('counts the terms the design prices: rounds, revisions and repair entries', async () => {
        const root = await fixture('counts');
        recordHistory(root, 'delivery', {
            events: [
                ['2026-01-01T00:00:00.000Z', '', 'intake'],
                ['2026-01-01T01:00:00.000Z', 'intake', 'plan'],
                ['2026-01-01T02:00:00.000Z', 'plan', 'implement'],
                ['2026-01-01T03:00:00.000Z', 'implement', 'hardVerify'],
                ['2026-01-01T04:00:00.000Z', 'hardVerify', 'review'],
                // A repair entry is a return to implement from a later phase, which is the predicate the phase machine replays.
                ['2026-01-01T05:00:00.000Z', 'review', 'implement'],
                ['2026-01-01T06:00:00.000Z', 'implement', 'hardVerify'],
            ],
            rounds: [['2026-01-01T04:30:00.000Z', 2], ['2026-01-01T06:30:00.000Z', 1]],
        });
        await createTaskRevisionIfChanged({ root, taskId: 'delivery', ownedPaths: ['src/a.ts'] });

        const metrics = await readChangeMetrics(root, 'delivery');
        expect(metrics.rounds.count).toBe(2);
        expect(metrics.rounds.perRound[1]?.sincePreviousMs).toBe(2 * 60 * 60 * 1000);
        expect(metrics.rounds.spanMs).toBe(2 * 60 * 60 * 1000);
        expect(metrics.repairs.entries).toBe(1);
        expect(metrics.revisions.count).toBe(1);
        expect(metrics.phase).toBe('hardVerify');
        // The states come from the modules that own them, so a metric cannot disagree with the gate it measures.
        expect(metrics.completion).toBe('uncertified');
        expect(metrics.dependency).toBe('absent');
        expect(metrics.correctiveAction.declared).toBe(false);
    });

    it('names what it cannot observe instead of leaving it as an implicit zero', async () => {
        const root = await fixture('honesty');
        recordHistory(root, 'delivery', { events: [['2026-01-01T00:00:00.000Z', '', 'intake']], rounds: [] });
        const metrics = await readChangeMetrics(root, 'delivery');
        expect(metrics.unmeasured.join(' ')).toMatch(/tokens/u);
        expect(metrics.unmeasured.join(' ')).toMatch(/active time/u);
        // And the durations are calendar time, with no round to place: `null`, not `0`.
        expect(metrics.rounds.spanMs).toBeNull();
    });

    it('counts a round row with no timestamp as unmeasured rather than as instant', () => {
        const rounds = summarizeRounds([
            { at: '2026-01-01T00:00:00.000Z', revisionId: 'r1', blockingIds: [], blockingCount: 1, findings: [] },
            { revisionId: 'r1', blockingIds: [], blockingCount: 1, findings: [] } as never,
        ]);
        expect(rounds).toHaveLength(2);
        expect(rounds[1]?.at).toBe('');
        expect(rounds[1]?.sincePreviousMs).toBeNull();
        expect(rounds.filter((round) => round.at === '')).toHaveLength(1);
    });

    it('folds phase occupancy from the event log in record order', () => {
        const spans = summarizePhases([
            { at: '2026-01-01T00:00:00.000Z', from: null, to: 'intake' },
            { at: '2026-01-01T00:30:00.000Z', from: 'intake', to: 'plan' },
        ]);
        expect(spans.map((span) => span.phase)).toEqual(['intake', 'plan']);
        expect(spans[0]?.elapsedMs).toBe(30 * 60 * 1000);
        expect(spans[1]?.elapsedMs).toBeNull();
    });
});

describe('the class view, where the inequality gets its numbers', () => {
    it('reports how many changes a class reaches, and how many rounds the source needed after the declaration', async () => {
        const root = await fixture('class-view');
        recordHistory(root, 'delivery', {
            events: [['2026-01-01T00:00:00.000Z', '', 'intake']],
            rounds: [['2026-01-01T01:00:00.000Z', 3], ['2026-01-01T02:00:00.000Z', 2], ['2026-01-01T03:00:00.000Z', 1]],
        });
        await declareCorrectiveAction({
            root,
            taskId: 'corrective',
            classKey: 'one-fact-derived-twice',
            sourceChangeId: 'delivery',
            owner: 'the-owner',
            obligation: {
                states: ['no record', 'record present'],
                sourceOfTruth: 'src/workflow/task-dependency.ts#decideTaskDependencies',
                inventory: ['src/workflow/task-dependency.ts the reader'],
                invariant: 'every consumer asks decideTaskDependencies',
                repairSurface: ['src/workflow/task-dependency.ts'],
                effectivenessTest: 'tests/unit/a-blocked-task-cannot-cross-its-gate.test.ts',
                ifRecursAgain: 'rewrite_mechanism',
            },
        });
        // A dependency edge is what makes the class reach more than its source change.
        await addKataRelation({ root, from: { type: 'task', id: 'delivery' }, to: { type: 'task', id: 'corrective' }, type: 'blocked_by', reason: 'the class' });

        const view = await readClassMetrics(root);
        expect(view.classes).toHaveLength(1);
        const entry = view.classes[0]!;
        expect(entry.classKey).toBe('one-fact-derived-twice');
        expect(entry.ownerTaskId).toBe('corrective');
        expect(entry.discharged).toBe(false);
        // The `A_i` shape: which changes this class reaches.
        expect(entry.dependentTasks).toEqual(['delivery']);
        // The `R_i` shape, restricted to what the records can see.
        expect(entry.roundsAfterDeclaration).toBeGreaterThanOrEqual(0);
        expect(view.unmeasured.join(' ')).toMatch(/counterfactual/u);
    });

    it('publishes the counts an operator decides on, through the CLI', async () => {
        const root = await fixture('cli');
        const view = await runMetricsCommand(['--all', '--root', root]);
        expect(view.command).toBe('metrics');
        expect(view.scope).toBe('repository');
        expect(view.openClasses).toBe(0);
        expect(view.classesReachingMoreThanOneChange).toBe(0);
        expect(Array.isArray(view.unmeasured)).toBe(true);
    });
});
