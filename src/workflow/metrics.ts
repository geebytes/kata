import { readdir } from 'node:fs/promises';
import { revisionsDir } from '../core/layout.js';
import { readKataRelations } from '../core/relations.js';
import { isRepairReturn, readStateEvents } from '../core/state.js';
import { readReviewRoundsState, type ReviewRound } from '../quality/repair.js';
import { readCorrectiveActions, readCorrectiveActionStatus } from './corrective-action.js';
import { readCompletion } from './completion.js';
import { readTaskDependency } from './task-dependency.js';

/**
 * **What a change cost, in the terms the design's own economics are written in.**
 *
 * The design prices route A with `Σ(A_i − R_i) > C + I + M`: the repeated repair a class would have caused across *i*
 * changes, against the cost of one corrective action plus its integration plus each dependent change's re-validation. Every
 * term in that inequality is a count that already exists in this repository's records — rounds, revisions, repair entries,
 * dependency edges, declarations — and none of them had a reader, so the inequality could only ever be argued about.
 *
 * **What this measures, and what it deliberately does not.** Elapsed time here is *calendar* time between two recorded
 * events: it includes the operator's attention, the model's own latency and every pause in between. It is not author time,
 * not reviewer time, and not tokens — kata never sees those (it makes no model calls), and a report that presented calendar
 * time as work time would be the same substitution this repository keeps finding one layer down. The counts are exact; the
 * durations are labelled for what they are, and the fields that are not observable are named as unmeasured rather than
 * estimated.
 *
 * Reuse rather than re-derivation: repair entries are counted with `isRepairReturn` — the predicate the phase machine
 * already uses to replay its own event log — and the completion, dependency and corrective-action states come from the
 * modules that own them, so a metric can never disagree with the gate it is measuring.
 */

/** One phase's occupancy, from the event log that records the transitions. */
export type PhaseSpan = {
    phase: string;
    enteredAt: string;
    leftAt: string | null;
    /** Calendar milliseconds spent in this phase as recorded; `null` for the phase the task is still in. */
    elapsedMs: number | null;
};

export type RoundMetric = {
    at: string;
    revisionId: string | null;
    blockingCount: number | null;
    findings: number;
    /** Calendar milliseconds since the previous recorded round; `null` for the first one. */
    sincePreviousMs: number | null;
};

export type ChangeMetrics = {
    taskId: string;
    phase: string | null;
    completion: string;
    dependency: string;
    correctiveAction: { declared: boolean; classKey?: string; discharged?: boolean };
    revisions: { count: number };
    rounds: {
        count: number;
        readState: 'absent' | 'readable' | 'unreadable';
        unmeasuredRounds: number;
        perRound: RoundMetric[];
        /** Calendar time from the first recorded round to the last; `null` with fewer than two. */
        spanMs: number | null;
    };
    repairs: { entries: number };
    phases: PhaseSpan[];
    /** The terms this reading cannot produce, named rather than left as an implicit zero. */
    unmeasured: string[];
};

function elapsedMs(from: string, to: string): number | null {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return end - start;
}

/** Phase occupancy, folded from the event log in record order — the same order recovery replays it in. */
export function summarizePhases(events: ReadonlyArray<{ at: string; from: string | null; to: string }>): PhaseSpan[] {
    const spans: PhaseSpan[] = [];
    for (const event of events) {
        const previous = spans.at(-1);
        if (previous !== undefined) {
            previous.leftAt = event.at;
            previous.elapsedMs = elapsedMs(previous.enteredAt, event.at);
        }
        spans.push({ phase: event.to, enteredAt: event.at, leftAt: null, elapsedMs: null });
    }
    return spans;
}

export function summarizeRounds(rounds: readonly ReviewRound[]): RoundMetric[] {
    const metrics: RoundMetric[] = [];
    let previousAt: string | null = null;
    for (const round of rounds) {
        const at = typeof round.at === 'string' ? round.at : null;
        metrics.push({
            at: at ?? '',
            revisionId: typeof round.revisionId === 'string' ? round.revisionId : null,
            blockingCount: typeof round.blockingCount === 'number' ? round.blockingCount : null,
            findings: Array.isArray(round.findings) ? round.findings.length : 0,
            sincePreviousMs: at !== null && previousAt !== null ? elapsedMs(previousAt, at) : null,
        });
        if (at !== null) previousAt = at;
    }
    return metrics;
}

/** How many revisions this change minted, from the store that holds them. */
async function countRevisions(root: string, taskId: string): Promise<number> {
    try {
        return (await readdir(revisionsDir(root, taskId))).length;
    } catch {
        return 0;
    }
}

export async function readChangeMetrics(root: string, taskId: string): Promise<ChangeMetrics> {
    const events = await readStateEvents(root, taskId);
    const roundsRead = await readReviewRoundsState(root, taskId);
    const perRound = summarizeRounds(roundsRead.rounds);
    const roundsWithTime = perRound.filter((round) => round.at !== '');
    const [completion, dependency, corrective] = await Promise.all([
        readCompletion(root, taskId),
        readTaskDependency(root, taskId),
        readCorrectiveActionStatus(root, taskId),
    ]);

    return {
        taskId,
        phase: events.at(-1)?.to ?? null,
        completion: completion.state,
        dependency: dependency.state,
        correctiveAction: corrective.readState === 'usable'
            ? { declared: true, classKey: corrective.declaration?.classKey, discharged: corrective.discharged }
            : { declared: false },
        revisions: { count: await countRevisions(root, taskId) },
        rounds: {
            count: roundsRead.rounds.length,
            readState: roundsRead.kind,
            // A round row with no readable timestamp is a round this reading cannot place in time, which is what
            // "unmeasured" means here — counted rather than silently treated as zero elapsed.
            unmeasuredRounds: perRound.filter((round) => round.at === '').length,
            perRound,
            spanMs: roundsWithTime.length >= 2
                ? elapsedMs(roundsWithTime[0]!.at, roundsWithTime.at(-1)!.at)
                : null,
        },
        repairs: { entries: events.filter((event) => event.from !== null && isRepairReturn(event.from, event.to)).length },
        phases: summarizePhases(events),
        unmeasured: [
            'author and reviewer active time (kata sees recorded events, not attention)',
            'model tokens and tool calls (kata makes no model calls)',
            'check execution time (recorded per evidence file, not aggregated here)',
        ],
    };
}

/**
 * The class view, which is where the design's inequality actually gets its numbers.
 *
 * `dependentTasks` is the `A_i` term's shape: how many changes this class reaches. One dependent change means the
 * corrective action cost more than it saved; several means it was amortized. `roundsAfterDeclaration` is the `R_i` term's
 * shape, restricted to what the records can see: rounds the *source* change still needed after the declaration was
 * recorded.
 */
export type ClassMetric = {
    classKey: string;
    owner: string;
    ownerTaskId: string;
    discharged: boolean;
    declaredAt: string;
    sourceChangeId: string;
    dependentTasks: string[];
    roundsAfterDeclaration: number;
    invariant: string;
};

export type ClassMetricsView = {
    classes: ClassMetric[];
    unreadable: Array<{ taskId: string; detail: string }>;
    /** Open classes reach one change; discharged ones may reach none. Published so a reader cannot read a gap as a zero. */
    unmeasured: string[];
};

export async function readClassMetrics(root: string): Promise<ClassMetricsView> {
    const { open, unreadable } = await readCorrectiveActions(root);
    // **The graph is read once**, not per class: it is one document, and a loop that re-read it would be the shape that lets
    // two classes be answered from two different states of the same file.
    let relations: Awaited<ReturnType<typeof readKataRelations>>['relations'] = [];
    let graphReadable = true;
    try {
        relations = (await readKataRelations(root)).relations;
    } catch {
        graphReadable = false;
    }
    const classes: ClassMetric[] = [];
    for (const entry of open) {
        const status = await readCorrectiveActionStatus(root, entry.taskId);
        const declaration = status.declaration;
        if (declaration === null) continue;

        // Who depends on it: the edges that point at this task, read through the graph the dependency gate reads.
        const dependentTasks = graphReadable
            ? [...new Set(relations
                .filter((relation) => relation.from.type === 'task' && relation.to.type === 'task' && relation.to.id === entry.taskId
                    && (relation.type === 'blocked_by' || relation.type === 'depends_on'))
                .map((relation) => relation.from.id))].sort()
            : [];

        const sourceRounds = await readReviewRoundsState(root, declaration.sourceChangeId);
        const declaredAtMs = Date.parse(declaration.declaredAt);
        const roundsAfterDeclaration = Number.isNaN(declaredAtMs)
            ? 0
            : sourceRounds.rounds.filter((round) => typeof round.at === 'string' && Date.parse(round.at) > declaredAtMs).length;

        classes.push({
            classKey: entry.classKey,
            owner: entry.owner,
            ownerTaskId: entry.taskId,
            discharged: entry.discharged,
            declaredAt: declaration.declaredAt,
            sourceChangeId: declaration.sourceChangeId,
            dependentTasks,
            roundsAfterDeclaration,
            invariant: entry.invariant,
        });
    }
    return {
        classes,
        unreadable,
        unmeasured: [
            'the rounds the class would have cost without the corrective action (a counterfactual, not a record)',
            'author time on the corrective action itself',
            ...(graphReadable ? [] : ['which changes depend on each class: the relation graph could not be read, so the count is unknown rather than zero']),
        ],
    };
}
