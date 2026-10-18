import { readValidatedOptional } from '../core/schema.js';
import { dependenciesPath, judgePath, reviewPath } from '../core/layout.js';
import { readKataRelations, type KataRelationWithLegacyId } from '../core/relations.js';
import { readCurrentStateOr, type StateRead } from '../core/state.js';
import { withRepositoryArtefactLock } from '../core/locks.js';
import { assertValidTaskId } from '../core/ids.js';
import { computeManifestHash, readCurrentTaskRevisionState } from './revision.js';
import { bindsToRevision, currentRevisionIdentityFrom, type VerdictBinding } from './verdict-binding.js';

/**
 * **The one decision about a task-to-task blocking edge, and the one gate every entry asks.**
 *
 * A dependency is the one workflow fact that is about *two* tasks, so it is the fact this repository's own defect class
 * (`one-fact-derived-twice`) is most likely to produce: the graph knows the edge, the corrective task's records know whether
 * it was certified, the tree knows whether the fix is present, and the dependent task's revision knows whether it has been
 * re-validated against that fix. Four readers for one question is how a task gets told to continue by `status` and refused by
 * `seal`, or the reverse. So the inputs are read once here and folded by one pure function, and every governed entry — seal,
 * verify, review, judge, archive, and the approval at each trust boundary — asks *this* function rather than re-deriving
 * "is the corrective task done".
 *
 * **Why the return is a separate record rather than a field on the edge.** The edge is topology and has one writer; the
 * return is a certification event. Recording it on the edge would make any later rewrite of that edge (a re-typed relation,
 * an id migration) silently re-certify a dependency nobody re-checked. The record also deliberately does not restate the
 * endpoints: the graph answers "blocked by which task", and this file answers only what the graph cannot.
 *
 * **Why `undetermined` is not an empty list.** A dependency whose inputs cannot be read is not "no dependency": that
 * collapse is the same defect this repository has already paid for at the revision pointer and the ledger. Every branch
 * below that cannot answer fails closed and names what it could not read.
 */

export type TaskDependencyState = 'absent' | 'pending' | 'undetermined' | 'ready_to_revalidate' | 'revalidated';

/** The governed entries a blocking edge can stop. `seal` also covers `build` (which seals unless asked not to). */
export type GovernedEntry = 'seal' | 'verify' | 'review' | 'judge' | 'archive';

/** Entries that may not run until the dependent task has been re-validated *on* the returned content. */
const ENTRY_NEEDS_REVALIDATION: Record<GovernedEntry, boolean> = {
    seal: false,
    verify: false,
    review: false,
    judge: true,
    archive: true,
};

export type DependencyEdge = {
    /** `null` on a v1 edge, which is a readable historical state and not a drifted one. */
    relationId: string | null;
    relationType: string;
    correctiveTaskId: string;
    reason?: string;
};

export type CorrectiveFacts = {
    taskId: string;
    taskReadState: 'absent' | 'usable' | 'unreadable';
    phase: string | null;
    revisionReadState: 'absent' | 'current' | 'unreadable';
    revisionId: string | null;
    /** `null` when the judge record could not be read; `false` when it read and does not certify this revision. */
    judgedPass: boolean;
    /**
     * **Whether the corrective action was independently reviewed, bound to the same revision.**
     *
     * Its own gates are three — verify, review, judge — and reading only the judge let a task that had never been
     * independently reviewed sign the receipt that unblocks another change. The binding rule is the shared one
     * (`bindsToRevision`), so "does this approval still speak for that content" has one answer in the repository.
     */
    reviewedApproved: boolean;
    /** The hash of the corrective revision's declared surface as it stands in *this* tree; `null` when it could not be hashed. */
    integratedContentHash: string | null;
};

export type DependencyReturn = {
    relationId: string;
    correctiveTaskId: string;
    correctiveRevisionId: string;
    integratedContentHash: string;
    subjectRevisionId?: string;
    recordedAt: string;
    recordedBy?: string;
    note?: string;
};

export type DependencyBlocker = {
    relationId: string | null;
    correctiveTaskId: string;
    state: 'pending' | 'undetermined';
    /** Machine-readable, stable, and what a caller keys on. */
    reason: string;
    detail: string;
    /** A command that runs *now* and moves this toward a legal next state, or `null` when only a human can act. */
    road: string | null;
};

export type TaskDependencyDecision = {
    taskId: string;
    state: TaskDependencyState;
    edges: DependencyEdge[];
    blockers: DependencyBlocker[];
    /** The dependent task's revision at read time; the identity a return is recorded against and compared with. */
    subjectRevisionId: string | null;
};

/** The one place a state becomes a sentence and a road. */
function blocker(input: {
    edge: DependencyEdge;
    state: 'pending' | 'undetermined';
    reason: string;
    detail: string;
    road: string | null;
}): DependencyBlocker {
    return {
        relationId: input.edge.relationId,
        correctiveTaskId: input.edge.correctiveTaskId,
        state: input.state,
        reason: input.reason,
        detail: input.detail,
        road: input.road,
    };
}

function statusRoad(taskId: string): string {
    return `kata-cli status --change ${taskId}`;
}

/**
 * The road for a corrective action that has not been independently reviewed yet.
 *
 * It names the review of *that* task rather than its status: the missing step is a review round, and an operator sent to
 * `status` would read a state they already know without learning what to run.
 */
function reviewRoad(taskId: string): string {
    return `kata-cli review --change ${taskId} (after \`kata-cli ledger run --change ${taskId}\`)`;
}

function recordRoad(taskId: string, edge: DependencyEdge): string | null {
    return edge.relationId === null
        ? null
        : `kata-cli dependency record --change ${taskId} --relation ${edge.relationId}`;
}

/**
 * **The decision, as a pure function of what was read.** No clock, no filesystem, no re-reading: a caller that has already
 * read the inputs can ask the same question the CLI asks, and a test can pose every state without a repository.
 *
 * Per edge, in order: an unreadable corrective task or revision is `undetermined` (nothing about the edge could be
 * evaluated); an uncertified corrective task is `pending` (the work is unfinished, which is a fact and not a doubt); a
 * missing return is `pending` (the human integration step has not happened); a corrective task whose revision moved after
 * the return, or whose accepted content is no longer in this tree, is `undetermined` (the return no longer speaks for the
 * edge); otherwise the edge is returned, and the dependent task's own movement is what separates `revalidated` from
 * `ready_to_revalidate`.
 *
 * Over edges: the worst state wins, because a task with two blocking edges is blocked by either of them. `undetermined` is
 * reported as itself and never folded into `pending`: "I could not tell" and "it is not done" have different remedies.
 */
export function decideTaskDependencies(input: {
    taskId: string;
    edges: readonly DependencyEdge[];
    corrective: readonly CorrectiveFacts[];
    returns: readonly DependencyReturn[];
    subjectRevisionId: string | null;
}): TaskDependencyDecision {
    const { taskId, edges, corrective, returns, subjectRevisionId } = input;
    if (edges.length === 0) {
        return { taskId, state: 'absent', edges: [], blockers: [], subjectRevisionId };
    }

    const correctiveById = new Map(corrective.map((facts) => [facts.taskId, facts]));
    const returnsByRelation = new Map(returns.map((record) => [record.relationId, record]));
    const blockers: DependencyBlocker[] = [];
    let everyEdgeRevalidated = true;

    for (const edge of edges) {
        const facts = correctiveById.get(edge.correctiveTaskId);
        if (!facts || facts.taskReadState === 'unreadable' || facts.revisionReadState === 'unreadable') {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'undetermined',
                reason: 'corrective_record_unreadable',
                detail: `The corrective task '${edge.correctiveTaskId}' could not be read, so nothing about this dependency could be evaluated.`,
                road: statusRoad(edge.correctiveTaskId),
            }));
            continue;
        }
        if (facts.taskReadState === 'absent' || facts.revisionReadState === 'absent' || facts.revisionId === null) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'pending',
                reason: 'corrective_not_certified',
                detail: `The corrective task '${edge.correctiveTaskId}' has no accepted revision yet, so it cannot have returned anything.`,
                road: statusRoad(edge.correctiveTaskId),
            }));
            continue;
        }
        if (!facts.judgedPass) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'pending',
                reason: 'corrective_not_certified',
                detail: `The corrective task '${edge.correctiveTaskId}' has revision '${facts.revisionId}' but no passing judge record bound to it, so its result is not independent.`,
                road: statusRoad(edge.correctiveTaskId),
            }));
            continue;
        }
        // **A judged corrective action is not yet an accepted one.** Its own review is the step that makes its result
        // independent of its author, and without it the receipt unblocking this change would rest on the author's own
        // conclusion — the shape the design refuses in as many words. Named as its own reason so the road is the review
        // rather than the judge the task already has.
        if (!facts.reviewedApproved) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'pending',
                reason: 'corrective_not_reviewed',
                detail: `The corrective task '${edge.correctiveTaskId}' has a passing judge record for revision '${facts.revisionId}' but no approved independent review bound to it, so nothing yet says the repair was accepted by anyone but its author.`,
                road: reviewRoad(edge.correctiveTaskId),
            }));
            continue;
        }

        const relationKey = edge.relationId;
        const record = relationKey === null ? undefined : returnsByRelation.get(relationKey);
        if (!record) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'pending',
                reason: 'return_not_recorded',
                detail: relationKey === null
                    ? `The edge blocking this task on '${edge.correctiveTaskId}' carries no relation id, so no return can be recorded for it; re-create the edge on a v2 graph.`
                    : `The corrective task '${edge.correctiveTaskId}' is certified, but no return has been recorded against edge '${relationKey}'.`,
                road: recordRoad(taskId, edge),
            }));
            continue;
        }
        if (record.correctiveRevisionId !== facts.revisionId) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'undetermined',
                reason: 'corrective_moved_after_return',
                detail: `Edge '${record.relationId}' returned revision '${record.correctiveRevisionId}', but the corrective task now stands at '${facts.revisionId}': the return answers a revision that is no longer current.`,
                road: recordRoad(taskId, edge),
            }));
            continue;
        }
        if (facts.integratedContentHash === null || facts.integratedContentHash !== record.integratedContentHash) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'undetermined',
                reason: 'integration_drifted',
                detail: `The content edge '${record.relationId}' returned is not what the tree holds over the corrective task's declared surface, so the fix is not present as certified.`,
                road: recordRoad(taskId, edge),
            }));
            continue;
        }

        // **`null` and `undefined` are the same fact here**: the record omits `subjectRevisionId` when the dependent task
        // had no revision when the return was recorded, and a later read of that same absence is `null`. Comparing the two
        // spellings as different would report a re-validation that never happened — measured while writing the first test
        // of this gate, where `judge` was permitted on a task that had not re-sealed anything.
        const hasRevalidated = (subjectRevisionId ?? null) !== (record.subjectRevisionId ?? null);
        if (!hasRevalidated) everyEdgeRevalidated = false;
    }

    if (blockers.some((entry) => entry.state === 'undetermined')) {
        return { taskId, state: 'undetermined', edges: [...edges], blockers, subjectRevisionId };
    }
    if (blockers.length > 0) {
        return { taskId, state: 'pending', edges: [...edges], blockers, subjectRevisionId };
    }
    return {
        taskId,
        state: everyEdgeRevalidated ? 'revalidated' : 'ready_to_revalidate',
        edges: [...edges],
        blockers: [],
        subjectRevisionId,
    };
}

/**
 * Whether `entry` may run under `decision`, and what to print when it may not.
 *
 * A refusal always names the reason and a road that runs from here. When no road exists, `road` is `null` and the message
 * says so rather than printing a command that would refuse: an unexecutable remedy is the one defect this repository has
 * found most often, and it is worth more than the convenience of always having something to print.
 */
export function dependencyRefusal(
    decision: TaskDependencyDecision,
    entry: GovernedEntry,
): { message: string; road: string | null } | null {
    if (decision.state === 'absent' || decision.state === 'revalidated') return null;

    if (decision.state === 'ready_to_revalidate') {
        if (!ENTRY_NEEDS_REVALIDATION[entry]) return null;
        const record = decision.blockers.length === 0 ? undefined : decision.blockers[0];
        return {
            message: `Cannot ${entry} '${decision.taskId}': the returned dependency has not been re-validated on this task's current content. `
                + `Re-seal and re-run the acceptance evidence on the integrated content first.`,
            road: record?.road ?? null,
        };
    }

    const lines = decision.blockers.map((entryBlocker) => `- [${entryBlocker.reason}] (${entryBlocker.state}) ${entryBlocker.detail}`);
    const roads = decision.blockers
        .map((entryBlocker) => entryBlocker.road)
        .filter((road): road is string => road !== null);
    const roadText = roads.length > 0
        ? `Next: ${roads[0]}`
        : `No command can clear this; a named owner has to decide it.`;
    return {
        message: `Cannot ${entry} '${decision.taskId}': this task is blocked by a corrective action that has not returned.\n`
            + `${lines.join('\n')}\n${roadText}`,
        road: roads[0] ?? null,
    };
}

/** The entries a blocking edge can stop, in the order a report prints them. */
const governedEntries: readonly GovernedEntry[] = ['seal', 'verify', 'review', 'judge', 'archive'];

/**
 * **What each governed entry would answer, for the surfaces that publish rather than gate.**
 *
 * Derived from `dependencyRefusal` rather than from the state, because the state alone is not enough to describe the
 * answer: `ready_to_revalidate` permits the seal and refuses the judge, so a summary that published only the state would
 * say "no blockers" beside a gate that refuses — the exact shape this repository has already paid for once, when a
 * status published `reviewFindings: 0` next to a ledger it could not read. One report, computed from the one refusal
 * function, consumed by `status` and by `dependency status` alike.
 */
export function dependencyEntryReport(decision: TaskDependencyDecision): Record<string, 'permitted' | { refused: string; road: string | null }> {
    return Object.fromEntries(governedEntries.map((entry) => {
        const refusal = dependencyRefusal(decision, entry);
        return [entry, refusal === null ? 'permitted' : { refused: refusal.message, road: refusal.road }];
    }));
}

/** A short, stable summary for the surfaces that publish rather than gate (`status`, the review request). */
export function summarizeTaskDependency(decision: TaskDependencyDecision): Record<string, unknown> {
    return {
        state: decision.state,
        taskId: decision.taskId,
        // Published beside the state, so no surface can report "nothing blocks" while an entry would refuse.
        entries: dependencyEntryReport(decision),
        edges: decision.edges.map((edge) => ({
            relationId: edge.relationId,
            correctiveTaskId: edge.correctiveTaskId,
            relationType: edge.relationType,
        })),
        blockers: decision.blockers.map((entry) => ({
            relationId: entry.relationId,
            correctiveTaskId: entry.correctiveTaskId,
            state: entry.state,
            reason: entry.reason,
            detail: entry.detail,
            road: entry.road,
        })),
    };
}

/**
 * **The edges that make a claim about this task's freedom to proceed.**
 *
 * `blocked_by` is the relation an operator writes for exactly this fact; `depends_on` is the older, weaker spelling of the
 * same intent, and it is read here so a dependency written before this module existed is not silently ignored. Both are
 * read only when they point at another *task*: a `blocked_by` edge to a change is an Initiative fact and is evaluated by
 * the Initiative's own closure rule, not by this one.
 */
export function dependencyEdgesFor(relations: readonly KataRelationWithLegacyId[], taskId: string): DependencyEdge[] {
    return relations
        .filter((relation) => relation.from.type === 'task'
            && relation.from.id === taskId
            && relation.to.type === 'task'
            && (relation.type === 'blocked_by' || relation.type === 'depends_on'))
        .map((relation) => ({
            relationId: relation.id ?? null,
            relationType: relation.type,
            correctiveTaskId: relation.to.id,
            ...(relation.reason === undefined ? {} : { reason: relation.reason }),
        }));
}

export type DependencyReturnsRead =
    | { kind: 'absent'; returns: DependencyReturn[] }
    | { kind: 'usable'; returns: DependencyReturn[] }
    | { kind: 'unreadable'; detail: string };

export async function readDependencyReturns(root: string, taskId: string): Promise<DependencyReturnsRead> {
    try {
        const record = await readValidatedOptional<{ returns: DependencyReturn[] }>('task-dependency', dependenciesPath(root, taskId));
        if (record === null) return { kind: 'absent', returns: [] };
        return { kind: 'usable', returns: record.returns };
    } catch (error) {
        return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
}

async function readCorrectiveFacts(root: string, taskId: string): Promise<CorrectiveFacts> {
    const state: StateRead = await readCurrentStateOr(root, taskId);
    const revisionRead = await readCurrentTaskRevisionState(root, taskId);
    const revision = revisionRead.kind === 'current' ? revisionRead.revision : null;

    let judgedPass = false;
    let reviewedApproved = false;
    if (revision) {
        try {
            const judge = await readValidatedOptional<{ result?: string; revisionId?: string }>('judge-result', judgePath(root, taskId));
            judgedPass = judge?.result === 'PASS' && judge.revisionId === revision.id;
        } catch {
            judgedPass = false;
        }
        try {
            // The identity comes from the read already in hand, never from a second read of a pointer written non-atomically.
            const identity = await currentRevisionIdentityFrom(revisionRead, root, taskId);
            const review = await readValidatedOptional<VerdictBinding & { status?: string }>('review', reviewPath(root, taskId));
            reviewedApproved = review?.status === 'approved' && bindsToRevision(review, identity);
        } catch {
            // A review record that cannot be read is not an approval. It is also not reported as one: the two facts are
            // distinct below, and a damaged record leaves the task where a missing one does — blocked, with the road.
            reviewedApproved = false;
        }
    }

    let integratedContentHash: string | null = null;
    if (revision && revision.ownedPaths.length > 0) {
        try {
            integratedContentHash = await computeManifestHash(root, revision.ownedPaths);
        } catch {
            integratedContentHash = null;
        }
    }

    return {
        taskId,
        taskReadState: state.kind === 'unreadable' ? 'unreadable' : state.kind === 'absent' ? 'absent' : 'usable',
        phase: state.kind === 'current' ? state.state.phase : null,
        revisionReadState: revisionRead.kind === 'unreadable' ? 'unreadable' : revisionRead.kind === 'absent' ? 'absent' : 'current',
        revisionId: revision?.id ?? null,
        judgedPass,
        reviewedApproved,
        integratedContentHash,
    };
}

/** Read this task's dependency decision from the repository. The one reader every governed entry and `status` uses. */
export async function readTaskDependency(root: string, taskId: string): Promise<TaskDependencyDecision> {
    assertValidTaskId(taskId);
    const graph = await readKataRelations(root);
    const edges = dependencyEdgesFor(graph.relations, taskId);
    const subject = await readCurrentTaskRevisionState(root, taskId);
    const subjectRevisionId = subject.kind === 'current' ? subject.revision.id : null;
    if (edges.length === 0) {
        return { taskId, state: 'absent', edges: [], blockers: [], subjectRevisionId };
    }

    // **A return record that cannot be read is `unreadable`, not empty.** Reading it as "no returns" would turn a damaged
    // record into a pending dependency that looks like the ordinary unfinished case, and an operator would act on the
    // wrong story. The read state is carried into the decision by treating every edge as unanswerable.
    const returnsRead = await readDependencyReturns(root, taskId);
    if (returnsRead.kind === 'unreadable') {
        return {
            taskId,
            state: 'undetermined',
            edges,
            blockers: edges.map((edge) => blocker({
                edge,
                state: 'undetermined',
                reason: 'return_record_unreadable',
                detail: `The dependency return record could not be read (${returnsRead.detail}), so no return can be trusted.`,
                road: `kata-cli dependency status --change ${taskId}`,
            })),
            subjectRevisionId,
        };
    }

    const corrective: CorrectiveFacts[] = [];
    for (const edge of edges) {
        corrective.push(await readCorrectiveFacts(root, edge.correctiveTaskId));
    }

    return decideTaskDependencies({
        taskId,
        edges,
        corrective,
        returns: returnsRead.returns,
        subjectRevisionId,
    });
}

/**
 * Refuse a governed entry that this task's dependencies do not permit.
 *
 * Called from the workflow entry itself rather than from the CLI, so a direct `runCommand` cannot bypass it (`S1`): the
 * road printed in the refusal is the same road `status` publishes, because both ask the same decision.
 */
export async function assertDependencyAllowsEntry(root: string, taskId: string, entry: GovernedEntry): Promise<void> {
    const decision = await readTaskDependency(root, taskId);
    const refusal = dependencyRefusal(decision, entry);
    if (refusal) throw new Error(refusal.message);
}

/**
 * Record that the corrective work a blocking edge names has returned, and that its accepted content is in this tree.
 *
 * **Refused when the corrective task is not independently certified.** The dependent task must not be able to declare its
 * own precondition met: this is the writer that makes `D --blocked_by--> C` clearable, so it is the writer that has to ask
 * the same question the gate asks. The integrated content is hashed here rather than accepted as an argument, because a
 * caller-supplied hash would be a second derivation of the fact the gate compares.
 */
export async function recordDependencyReturn(input: {
    root: string;
    taskId: string;
    relationId: string;
    recordedBy?: string;
    note?: string;
}): Promise<{ record: DependencyReturn; decision: TaskDependencyDecision }> {
    const { root, taskId, relationId } = input;
    assertValidTaskId(taskId);
    const graph = await readKataRelations(root);
    const edge = dependencyEdgesFor(graph.relations, taskId).find((candidate) => candidate.relationId === relationId);
    if (!edge) {
        throw new Error(`No task-to-task blocking edge '${relationId}' starts at '${taskId}'; read them with \`kata-cli dependency status --change ${taskId}\`.`);
    }
    const facts = await readCorrectiveFacts(root, edge.correctiveTaskId);
    if (facts.revisionId === null || facts.revisionReadState !== 'current') {
        throw new Error(`Cannot record a return for edge '${relationId}': the corrective task '${edge.correctiveTaskId}' has no readable accepted revision.`);
    }
    if (!facts.reviewedApproved) {
        throw new Error(
            `The corrective task '${edge.correctiveTaskId}' has a passing judge record but no approved independent review bound to `
            + `revision '${facts.revisionId ?? '<none>'}', so its result is not yet independent of its author and cannot sign the receipt `
            + `that unblocks '${input.taskId}'. Review it first: ${reviewRoad(edge.correctiveTaskId)}.`,
        );
    }
    if (!facts.judgedPass) {
        throw new Error(`Cannot record a return for edge '${relationId}': the corrective task '${edge.correctiveTaskId}' stands at '${facts.revisionId}' without a passing judge record bound to it, so there is nothing independent to return.`);
    }
    if (facts.integratedContentHash === null) {
        throw new Error(`Cannot record a return for edge '${relationId}': the accepted surface of '${edge.correctiveTaskId}' could not be hashed in this tree.`);
    }

    const subject = await readCurrentTaskRevisionState(root, taskId);
    const subjectRevisionId = subject.kind === 'current' ? subject.revision.id : null;
    const record: DependencyReturn = {
        relationId,
        correctiveTaskId: edge.correctiveTaskId,
        correctiveRevisionId: facts.revisionId,
        integratedContentHash: facts.integratedContentHash,
        ...(subjectRevisionId === null ? {} : { subjectRevisionId }),
        recordedAt: new Date().toISOString(),
        ...(input.recordedBy === undefined ? {} : { recordedBy: input.recordedBy }),
        ...(input.note === undefined ? {} : { note: input.note }),
    };

    const path = dependenciesPath(root, taskId);
    await withRepositoryArtefactLock(root, 'task-dependency', path, async (current) => {
        const existing = current.trim() === '' ? { taskId, updatedAt: '', returns: [] as DependencyReturn[] } : JSON.parse(current) as {
            taskId: string;
            updatedAt: string;
            returns: DependencyReturn[];
        };
        // Replace rather than append: a second return for the same edge supersedes the first, because two answers to one
        // edge is the state a reader would have to choose between.
        const returns = [...existing.returns.filter((entry) => entry.relationId !== relationId), record];
        return `${JSON.stringify({ taskId, updatedAt: new Date().toISOString(), returns }, null, 2)}\n`;
    });

    return { record, decision: await readTaskDependency(root, taskId) };
}

