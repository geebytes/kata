import { join } from 'node:path';
import { taskDir } from '../core/layout.js';
import { readDirectoryState, readRecordState } from '../core/record-read.js';
import { reviewProgress, type ReviewRound, type ReviewProgress } from './repair.js';
import type { RecurrencePacket } from './recurrence-packet.js';

/**
 * **The unit a repair chain converges on, because a revision is too small a unit to converge on.**
 *
 * Every repair seals a new revision. `assessReviewLoop` scopes its rounds to the current revision — correctly, because a
 * round about other content is not a reading of this content — so entering review after a repair writes a round bound to
 * the new revision, the previous revision's rounds become history about something else, and the count restarts. A loop
 * that repaired eight times therefore reports one or two rounds every time it is asked, and the escalation that reads
 * "three rounds without progress" can never fire. Measured: eight rounds, eight distinct revision ids, `noProgressRounds`
 * never above 1.
 *
 * The lineage is the fix, and it is not a loosening of evidence freshness: the revision still decides whether a *piece of
 * evidence* still speaks for the content in hand. The lineage decides a different question — "has this repair chain been
 * reducing its problems at all" — and it is derived from the change records, not from a new field a writer could forget
 * to stamp.
 *
 * **Derived, not stored.** A record already carries `revisionId` and `baseRevisionId`, so the chain is a walk over the
 * records the seal already wrote: `<task>/change-record-<revisionId>.json` names its own parent. A stored
 * `repairLineageId` would be a second answer to a question these two fields already answer, and the second answer is the
 * one that drifts (`one-fact-derived-twice`, the class this repository pays for most often).
 */

/** One sealed revision in a repair chain, and the revision it was sealed on top of. */
export interface LineageLink {
    revisionId: string;
    baseRevisionId?: string;
}

export type RepairLineageRead =
    | { kind: 'absent' }
    | { kind: 'unreadable'; detail: string }
    | { kind: 'usable'; chain: LineageLink[]; revisionIds: string[]; rootRevisionId: string };

const REVISION_RECORD = /^change-record-(.+)\.json$/;

/**
 * Walk the change records back from a revision to the one the chain started on.
 *
 * The walk is bounded by the revisions that were actually read: a record whose parent was never sealed (a revision
 * imported, or one whose record could not be read) ends the chain rather than looping, and every visited id is recorded so
 * a cycle cannot spin. A directory that cannot be listed is `unreadable`, never "no lineage": the two states route
 * differently, and folding them together is how an operator gets told a repair chain does not exist while it is on disk.
 */
export async function readRepairLineage(
    root: string,
    taskId: string,
    currentRevisionId: string,
): Promise<RepairLineageRead> {
    const directory = taskDir(root, taskId);
    const listing = await readDirectoryState(directory);
    if (listing.kind === 'absent') return { kind: 'absent' };
    if (listing.kind === 'unreadable') return { kind: 'unreadable', detail: listing.detail };

    const recorded = new Map<string, LineageLink>();
    for (const entry of listing.entries) {
        const match = REVISION_RECORD.exec(entry);
        if (!match) continue;
        const read = await readRecordState<{ revisionId?: unknown; baseRevisionId?: unknown }>(
            join(directory, entry),
        );
        // **A record that cannot be read is not a link that is not there.** The chain would silently stop at it and the
        // lineage would report fewer revisions than the task sealed, which is the reading that hides a stalled chain. The
        // id comes from the filename, which is the only thing that survives a damaged body.
        if (read.kind === 'unreadable') return { kind: 'unreadable', detail: read.detail };
        if (read.kind === 'absent') continue;
        const declared = typeof read.value.revisionId === 'string' ? read.value.revisionId : match[1];
        recorded.set(declared, {
            revisionId: declared,
            ...(typeof read.value.baseRevisionId === 'string' ? { baseRevisionId: read.value.baseRevisionId } : {}),
        });
    }

    const chain: LineageLink[] = [];
    const visited = new Set<string>();
    let revisionInWalk: string | undefined = currentRevisionId;
    while (revisionInWalk !== undefined && !visited.has(revisionInWalk)) {
        visited.add(revisionInWalk);
        const link: LineageLink = recorded.get(revisionInWalk) ?? { revisionId: revisionInWalk };
        chain.push(link);
        revisionInWalk = link.baseRevisionId;
    }
    if (chain.length === 0) return { kind: 'absent' };
    const rootRevisionId = chain[chain.length - 1].revisionId;
    return {
        kind: 'usable',
        // Oldest first: the reading is "what happened, in order", and every consumer below walks it forward.
        chain: [...chain].reverse(),
        revisionIds: [...visited],
        rootRevisionId,
    };
}

/**
 * **The same progress arithmetic over the chain instead of over one revision.**
 *
 * It is `reviewProgress` — the exported, separately-tested function — and not a second implementation of it, so
 * "the count is not falling" has one definition whether the set handed to it is one revision or a chain. What differs is
 * only the set: rounds whose revision belongs to the chain, and a legacy round that names no revision participates, which
 * is the opposite of the revision-scoped reading. That is deliberate and not a loosening — a line with no revision is
 * history that cannot claim *which* content it read, and the lineage question ("has this chain reduced its problems") is
 * about the chain, so unclaimable history is still history about this chain. The revision-scoped reading keeps refusing it,
 * because there the question is about a specific revision.
 */
export interface LineageProgress {
    progress: ReviewProgress;
    /** The revisions the rounds were drawn from, oldest first, so the report can name the chain it judged. */
    revisions: string[];
    /** When the chain holds a single revision: not a lineage yet, and the caller says so rather than reporting a verdict. */
    singleRevision: boolean;
}

export function lineageProgress(
    lineage: { revisionIds: string[]; chain: LineageLink[] },
    rounds: readonly ReviewRound[],
): LineageProgress {
    const ids = new Set(lineage.revisionIds);
    const scoped = rounds.filter((round) => round.revisionId === undefined || ids.has(round.revisionId));
    return {
        progress: reviewProgress(scoped),
        revisions: lineage.chain.map((link) => link.revisionId),
        singleRevision: lineage.chain.length <= 1,
    };
}

/**
 * **Which of the three review activities a round is — and the reason the protocol needed the word.**
 *
 * Formal inspection distinguishes an inspection, its follow-up, and the causal analysis that follows a recurrence; this
 * protocol had one activity, so every round after a repair was dispatched with the same "review this change" brief. A
 * careful independent reader then does the only defensible thing with that brief and reviews everything — including the
 * repair — which is how a loop re-finds a defect in its own fix in every round (measured here: fifty of the fifty-one
 * classified findings across eight rounds were defects the previous round's repair had introduced or missed).
 *
 * The kind is derived, so no caller can choose the convenient one:
 *
 * - `root_cause` when the recurrence packet fired — the round's job is the cause, not another certification;
 * - `focused_followup` when the chain holds an earlier revision whose round recorded findings — there is a repair batch to
 *   verify, and the round's scope is that batch and its dependency cone;
 * - `certification` otherwise: nothing has been reviewed on this chain yet, so the round owns the whole revision.
 *
 * It is a scope statement and not a gate: a follow-up that finds a blocking defect outside the batch reports it, because a
 * defect is a defect wherever it is found. What the kind changes is where the round is *obliged* to look, and therefore
 * what "this round found nothing" is allowed to mean.
 */
export const REVIEW_KINDS = ['certification', 'focused_followup', 'root_cause'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/**
 * **The round a follow-up is verifying: the repair batch, with the findings it has to close.**
 *
 * `focused_followup` was a word with no object. The request carried the kind and the lineage counts, and nothing that said
 * *which* findings this round follows up, on which paths, or what closes them — so a careful reviewer does the only defensible
 * thing with a brief that says "verify the repair batch" and no more, and re-reads the whole change. That is the scope the
 * review loop was stuck on, handed back by the protocol that was supposed to narrow it.
 */
export interface RepairBatch {
    /** The round that recorded these findings, by its own timestamp — the round this one follows up. */
    roundAt: string;
    /** The revision that round measured: the content that was repaired to produce what is in hand. */
    revisionId?: string;
    /** What that round found, by id, with the class and authorship it recorded. A finding with no class is reported as such. */
    findings: Array<{ id: string; severity: string; class?: string; origin?: string }>;
}

/** Everything the review loop knows about where it is, derived once from the rounds, the chain and the declarations. */
export interface ReviewLoopState {
    /** Which of the three activities this round is. */
    kind: ReviewKind;
    /** The repair batch a follow-up verifies; `null` when nothing has been found since the last repair. */
    batch: RepairBatch | null;
    /** The chain in hand, oldest first — empty when there is none. */
    chain: string[];
    /** Classes a later round has already answered with `not_same_class`, so the packet stops asking about them. */
    clearedClasses: string[];
    /**
     * The recurrence packet this round is dispatched with, or `null` when there is no open recurrence question.
     *
     * Carried here rather than derived by each caller: the packet is filtered by what earlier rounds answered, and a caller
     * that derived it unfiltered demanded a root-cause conclusion from a round whose brief did not ask for one — the same
     * decision made twice with two answers.
     */
    packet: RecurrencePacket | null;
    /** Why the chain could not be read, when it could not — the reason the kind is a certification rather than a verdict. */
    lineageUnreadable?: string;
}

/**
 * The loop's state for a round: one read of the rounds, the chain and the declarations, three answers.
 *
 * **One derivation, because these three are one fact read three ways.** The kind says what the round is obliged to read, the
 * batch says what it is obliged to close, and the cleared classes say which questions earlier rounds have already answered —
 * all three come from "what has this chain done so far", and deriving any of them from a second read of the same files is the
 * `one-fact-derived-twice` class this repository pays for most often.
 *
 * **Kind is a state, so both kinds need an exit — and the first version gave neither one.** It answered `root_cause` for as
 * long as the packet fired (derived from the whole history, so it fired forever) and `focused_followup` for as long as any
 * earlier revision had recorded a finding (history that never stops being true). A round kind with no exit is a loop with no
 * end: a clean follow-up closes the batch, and a class a round has answered is not asked again — so the chain can reach
 * `certification` again, which is what "the repair held" looks like from here.
 */
export async function readLoopState(input: {
    root: string;
    taskId: string;
    /** The revision the round will measure; `undefined` when the task has none yet. */
    currentRevisionId: string | undefined;
}): Promise<ReviewLoopState> {
    const { readReviewRoundsState } = await import('./repair.js');
    const { classOccurrences, clearedClasses: clearedOf, readRepairDeclarations } = await import('./repair-declarations.js');
    const { recurrencePacketOfReadable } = await import('./recurrence-packet.js');
    const roundsRead = await readReviewRoundsState(input.root, input.taskId);
    const rounds = roundsRead.kind === 'readable' ? roundsRead.rounds : [];
    const lineage = input.currentRevisionId === undefined
        ? { kind: 'absent' as const }
        : await readRepairLineage(input.root, input.taskId, input.currentRevisionId);
    const chain = lineage.kind === 'usable' ? lineage.chain.map((link) => link.revisionId) : [];
    const declarations = await readRepairDeclarations(input.root, input.taskId, chain);
    const occurrences = classOccurrences(rounds);
    const cleared = declarations.kind === 'readable' ? clearedOf(declarations.declarations, occurrences) : [];
    const current = input.currentRevisionId;
    // **The previous round is the last one recorded, by append order.** The rounds file is append-only and never re-sorted
    // (its rows are the write order of the loop), so the last row is the round that just happened.
    const previous = rounds.at(-1);
    const batch: RepairBatch | null = previous !== undefined
        && (previous.findings?.length ?? 0) > 0
        && previous.revisionId !== current
        ? {
            roundAt: previous.at,
            ...(previous.revisionId === undefined ? {} : { revisionId: previous.revisionId }),
            findings: (previous.findings ?? []).map((finding) => ({
                id: finding.id,
                severity: finding.severity,
                ...(typeof finding.class === 'string' ? { class: finding.class } : {}),
                ...(typeof finding.origin === 'string' ? { origin: finding.origin } : {}),
            })),
        }
        : null;
    // **The packet, filtered by what has already been answered.** Derived unfiltered it keeps raising a class a later round
    // concluded `not_same_class` about, so every round after that is dispatched as a root-cause round whose question was
    // already answered — and the `resume_certification` next-action the vocabulary defines is unreachable from a request.
    const unfiltered = recurrencePacketOfReadable(roundsRead, {
        reviewRounds: `.kata/tasks/${input.taskId}/review-rounds.jsonl`,
        reviewHistory: `.kata/tasks/${input.taskId}/review-history.jsonl`,
        currentReview: `.kata/tasks/${input.taskId}/review.json`,
    });
    const remaining = unfiltered === null ? [] : unfiltered.classes.filter((entry) => !cleared.includes(entry.class));
    const packet = unfiltered === null || remaining.length === 0 ? null : { ...unfiltered, classes: remaining };
    // **A root-cause question is asked once.** The packet is derived from the whole history, so it fires again after a round
    // has answered it; without this the conclusion that round wrote is never acted on, because the next round is told to
    // produce the conclusion again instead of verifying the repair it contracted. The revision that counts is the one the
    // batch was recorded against as well as the one in hand: the conclusion was written *about* the repaired content, and the
    // repair that followed it is exactly what the next round has to check.
    const answered = declarations.kind === 'readable'
        && declarations.declarations.some((declaration) => declaration.revisionId === current
            || declaration.revisionId === batch?.revisionId);
    const kind = deriveReviewKind({
        recurrencePacketFired: packet !== null,
        recurrenceAlreadyDeclared: answered,
        lineage,
        currentRevisionId: current ?? '',
        // The rule reads the **last** round: the batch is the round that just happened, and passing the whole history here
        // would let a finding from four revisions ago keep answering "is there a repair to verify".
        rounds,
    });
    return {
        kind,
        batch,
        chain,
        clearedClasses: cleared,
        packet,
        ...(lineage.kind === 'unreadable' ? { lineageUnreadable: lineage.detail } : {}),
    };
}

export function deriveReviewKind(input: {
    /** Whether the recurrence circuit breaker fired for this round, already filtered by what earlier rounds answered. */
    recurrencePacketFired: boolean;
    /** Whether a root-cause conclusion has already been recorded at the revision in hand. */
    recurrenceAlreadyDeclared: boolean;
    lineage: RepairLineageRead;
    currentRevisionId: string;
    rounds: readonly ReviewRound[];
}): ReviewKind {
    if (input.recurrencePacketFired && !input.recurrenceAlreadyDeclared) return 'root_cause';
    // **The previous round, not "any earlier round".** The batch is the round that just happened: a follow-up that came back
    // clean closes it, and a rule asking "has any earlier revision ever recorded a finding" answers yes forever — the same
    // stickiness the kind had for `root_cause`.
    const previous = input.rounds.at(-1);
    const hasBatch = previous !== undefined
        && (previous.findings?.length ?? 0) > 0
        && previous.revisionId !== input.currentRevisionId;
    return hasBatch ? 'focused_followup' : 'certification';
}
