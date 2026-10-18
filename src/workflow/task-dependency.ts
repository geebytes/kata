import { createHash } from 'node:crypto';
import { readValidatedOptional } from '../core/schema.js';
import { dependenciesPath, judgePath, reviewPath } from '../core/layout.js';
import { readKataRelations, type KataRelationWithLegacyId } from '../core/relations.js';
import { readCurrentStateOr, type StateRead } from '../core/state.js';
import { withRepositoryArtefactLock } from '../core/locks.js';
import { assertValidTaskId } from '../core/ids.js';
import { computeManifestHash, readCurrentTaskRevisionState } from './revision.js';
import { bindsToRevision, currentRevisionIdentityFrom, speaksForDependency, type VerdictBinding } from './verdict-binding.js';
import { certificationSurfaceFor } from '../quality/certification-surface.js';

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
    /**
     * When the edge was declared — the earliest recorded fact about this dependency, and therefore the moment its age is
     * measured from. Absent on a v1 edge whose record carries no timestamp, which is reported as unmeasured rather than
     * silently treated as "just now".
     */
    declaredAt?: string;
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
    /**
     * **The certification-surface entries this corrective action's certified content edits.**
     *
     * A change that modifies the machinery deciding whether it is certified cannot be its own evidence of soundness, and no
     * independent evaluator exists to take that place — so its qualification is `undetermined`, which is what the design
     * says and what this list is for (`src/quality/certification-surface.ts`). Read from the **certified revision's**
     * owned paths, not from `task.json`: the frozen revision is the content that would be certified.
     */
    touchesCertificationMachinery: string[];
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
    /** The state this one edge reports: `pending`/`undetermined` while outstanding, `ready_to_revalidate` once it returned without the dependent task re-certifying under it. */
    state: 'pending' | 'undetermined' | 'ready_to_revalidate';
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
    /**
     * The dependency identity a verdict about this task must name (§6.2), or `null` when no edge claims it.
     *
     * Published on the decision rather than derived by each consumer, so the value a verdict is stamped with and the value
     * it is later compared against cannot come from two different readings of the graph.
     */
    dependencyIdentity: string | null;
};

/** The one place a state becomes a sentence and a road. */
function blocker(input: {
    edge: DependencyEdge;
    // The same union as `DependencyBlocker['state']`: a blocker reports what one edge is waiting for, and that includes the
    // returned-but-not-re-certified state.
    state: DependencyBlocker['state'];
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

/**
 * The roads for a corrective action that edits the certifier.
 *
 * **Both are commands that exist and run**, because a refusal whose road cannot be walked is the defect this repository has
 * paid for twice already. They are also the whole set: an independent evaluator that could verify the candidate's artifact
 * is exactly what does not exist yet, so naming one here would be printing a road nobody can take. Separating the work and
 * abandoning the change are what an operator can actually do today.
 */
function certifierRoad(taskId: string): string {
    return `separate the certifier work into its own change (kata-cli scope change --change ${taskId} … and kata-cli scope apply), `
        + `or stop this one: kata-cli completion stop --change ${taskId} --reason <why>`;
}

function recordRoad(taskId: string, edge: DependencyEdge): string | null {
    // An id-less edge never reaches a `return_not_recorded` blocker (it is refused as `legacy_undetermined` first), so this
    // answers for id-bearing edges only and the migration road lives with the refusal that needs it.
    return edge.relationId === null
        ? legacyEdgeRoad(taskId, edge)
        : `kata-cli dependency record --change ${taskId} --relation ${edge.relationId}`;
}

/**
 * The migration an id-less edge needs, as a command that runs.
 *
 * Re-stating the same edge is the migration, not a workaround: `addKataRelation` replaces the edge it matches and mints the
 * id inside its locked write, which is the write-side migration the reader deliberately refuses to perform. Measured: after
 * running it the graph is version 2, the edge has an id, and the machinery answers the dependency normally.
 */
function legacyEdgeRoad(taskId: string, edge: DependencyEdge): string {
    return `kata-cli relations add --from task:${taskId} --to task:${edge.correctiveTaskId} --type ${edge.relationType} --reason "<why this task depends on it>"`;
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
    /**
     * **This task's own judge record, read by the caller so the decision stays pure.**
     *
     * `revalidated` is the design's "D completed the evidence and review the new dependency identity requires", not merely
     * "D re-sealed": a judge record that names an older dependency identity (or names none, which is what a verdict written
     * before the edge existed looks like) means the certification predates the fact it would have to speak for.
     */
    subjectJudge?: { dependencyIdentity?: string } | null;
}): TaskDependencyDecision {
    const { taskId, edges, corrective, returns, subjectRevisionId } = input;
    if (edges.length === 0) {
        return { taskId, state: 'absent', edges: [], blockers: [], subjectRevisionId, dependencyIdentity: null };
    }
    // Derived once, here, from the inputs the decision was handed: every branch below and every consumer reads this value.
    const dependencyIdentity = dependencyIdentityOf({ edges, corrective, returns });

    const correctiveById = new Map(corrective.map((facts) => [facts.taskId, facts]));
    const returnsByRelation = new Map(returns.map((record) => [record.relationId, record]));
    const blockers: DependencyBlocker[] = [];
    let everyEdgeRevalidated = true;

    for (const edge of edges) {
        // **An edge written before ids existed is not a dependency this mechanism can answer, and that is asked first.**
        //
        // §6.5: *"旧 blocked_by 含义不明时标 legacy-undetermined，由 owner 迁移，不得默认已解决。"* Measured before this branch
        // existed: a v1 `blocked_by` edge (no `id`, which is what every pre-id graph holds — the reader deliberately does not
        // mint one) was reported as `pending`/`corrective_not_certified`, sending the operator to inspect the corrective task
        // even when that task was perfectly certified. The truth is that no return can *ever* be recorded against such an edge,
        // because a return is keyed by a relation id it does not have.
        //
        // It is asked **before every statement about the corrective task**, because none of those statements can be acted on
        // through an edge that cannot be recorded against: "C has not returned", "C edits the certifier" and "C is certified
        // but unrecorded" are all answers to a question this edge cannot carry. The state is `undetermined` rather than
        // `pending` for the same reason — the remedy is the migration, and it is a command that exists: re-stating the edge on
        // the current graph mints its id inside the writer's locked write, leaving an edge the machinery can answer.
        if (edge.relationId === null) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'undetermined',
                reason: 'legacy_undetermined',
                detail: `The edge blocking this task on '${edge.correctiveTaskId}' carries no relation id, so its meaning cannot be `
                    + `established: it was written before edges had ids, and no dependency return can be recorded against it. `
                    + `It is not treated as unresolved work by '${edge.correctiveTaskId}'.`,
                road: legacyEdgeRoad(taskId, edge),
            }));
            continue;
        }
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
        // **Asked before the records, because no record can answer it.** A corrective action that edits the modules judging
        // it would be certified by a rule it wrote; its own PASS is then the only evidence the rule is sound, which is the
        // self-certification this repository refuses at every other layer. `undetermined` — not `pending` — because the
        // remedy is not more work by C: it is an independent evaluator, which does not exist yet, or separating the work.
        if (facts.touchesCertificationMachinery.length > 0) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'undetermined',
                reason: 'corrective_changes_the_certifier',
                detail: `The corrective task '${edge.correctiveTaskId}' edits the machinery that decides whether it is certified `
                    + `(${facts.touchesCertificationMachinery.join(', ')}), so its own records cannot be the evidence that the rules are sound.`,
                road: certifierRoad(edge.correctiveTaskId),
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

        // **Only id-bearing edges reach here.** An id-less edge was refused above as `legacy_undetermined`, so this lookup can
        // no longer miss for that reason — which is what makes the branch below a statement about work rather than about a
        // record that can never exist.
        const relationKey = edge.relationId as string;
        const record = returnsByRelation.get(relationKey);
        if (!record) {
            everyEdgeRevalidated = false;
            blockers.push(blocker({
                edge,
                state: 'pending',
                reason: 'return_not_recorded',
                detail: `The corrective task '${edge.correctiveTaskId}' is certified, but no return has been recorded against edge '${relationKey}'.`,
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
        return { taskId, state: 'undetermined', edges: [...edges], blockers, subjectRevisionId, dependencyIdentity };
    }
    if (blockers.length > 0) {
        return { taskId, state: 'pending', edges: [...edges], blockers, subjectRevisionId, dependencyIdentity };
    }

    // **`revalidated` is a claim about evidence, not about a pointer.** Every edge returned and this task re-sealed, but its
    // judge record must also **name this dependency identity**: a record that names an older one was certified under a
    // dependency that has since moved, and a record that names none predates the edge entirely. Both are the design's "D 的
    // 旧 Review/Judge 结论必须失效或进入具名需重验", reported as the named re-validation state rather than as a quiet pass —
    // and the reason is its own, because the remedy (re-run the certification) differs from the remedy for "not yet returned".
    const judgeSpeaks = speaksForDependency(input.subjectJudge, dependencyIdentity);
    if (everyEdgeRevalidated && !judgeSpeaks) {
        return {
            taskId,
            state: 'ready_to_revalidate',
            edges: [...edges],
            blockers: edges.map((edge) => blocker({
                edge,
                state: 'ready_to_revalidate',
                reason: 'revalidated_under_an_older_dependency',
                detail: `The corrective work has returned, but this task's own judge record does not name the current dependency identity `
                    + `(${dependencyIdentity ?? '<none>'}): the certification predates the dependency it would have to speak for.`,
                road: `kata-cli status --change ${taskId}`,
            })),
            subjectRevisionId,
            dependencyIdentity,
        };
    }
    return {
        taskId,
        state: everyEdgeRevalidated ? 'revalidated' : 'ready_to_revalidate',
        edges: [...edges],
        blockers: [],
        subjectRevisionId,
        dependencyIdentity,
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

/**
 * **The published shape of the decision — one type, because there is more than one publisher now.**
 *
 * `status` and the review request both hand this to a reader, and a second shape for the same fact is how two surfaces come
 * to describe one dependency differently. The type is the contract; the function is the only producer.
 */
export interface TaskDependencySummary {
    state: string;
    taskId: string;
    /** What each governed entry would answer, so a summary can never say "nothing blocks" beside a gate that refuses. */
    entries: Record<string, 'permitted' | { refused: string; road: string | null }>;
    edges: Array<{ relationId: string | null; correctiveTaskId: string; relationType: string }>;
    blockers: Array<{ relationId: string | null; correctiveTaskId: string; state: string; reason: string; detail: string; road: string | null }>;
}

/** A short, stable summary for the surfaces that publish rather than gate (`status`, the review request). */
export function summarizeTaskDependency(decision: TaskDependencyDecision): TaskDependencySummary {
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
            ...(typeof relation.createdAt === 'string' ? { declaredAt: relation.createdAt } : {}),
        }));
}

export type DependencyReturnsRead =
    | { kind: 'absent'; returns: DependencyReturn[]; updatedAt: null }
    | { kind: 'usable'; returns: DependencyReturn[]; updatedAt: string | null }
    | { kind: 'unreadable'; detail: string };

export async function readDependencyReturns(root: string, taskId: string): Promise<DependencyReturnsRead> {
    try {
        const record = await readValidatedOptional<{ returns: DependencyReturn[]; updatedAt?: string }>('task-dependency', dependenciesPath(root, taskId));
        if (record === null) return { kind: 'absent', returns: [], updatedAt: null };
        // The record's own `updatedAt` travels with the returns: it is the generation this read saw, and a decision assembled
        // from a record that was rewritten underneath it is a decision about a state that never existed.
        return { kind: 'usable', returns: record.returns, updatedAt: record.updatedAt ?? null };
    } catch (error) {
        return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * **The generations a dependency answer is assembled from, read as one snapshot.**
 *
 * The design asks for a rejection or recovery strategy for a mixed-generation read (§6.2: *"涉及 task 锁与 repo 关系图锁的
 * 跨记录写入须有确定顺序、可重试的幂等步骤和混代读的拒绝/恢复策略；不要假定两次独立写入天然原子"*). A dependency answer is
 * assembled from **four** files that are written by different writers under different locks — the relation graph, the return
 * record, the corrective task's revision pointer and this task's own — so an answer read across them describes a state no
 * moment in time ever held. Every field here is a value the answer already used, so the check costs one extra read of each
 * and cannot drift from the answer it guards.
 */
export type DependencyGeneration = {
    graphUpdatedAt: string;
    returnsUpdatedAt: string | null;
    subjectRevisionId: string | null;
    correctiveRevisionIds: Record<string, string | null>;
};

/**
 * **The dependency identity (§6.2): what a verdict about this task is conditional on, as one value.**
 *
 * The design separates it from the content identity in as many words — *"不要将内容身份与依赖身份混为一个哈希"* — and the reason
 * is mechanical: a revision id answers "which code", and the facts here answer "under which dependency". Folding them into
 * one hash would make each able to launder the other: re-sealing unchanged content would look like a new dependency, and a
 * moved dependency would look like unchanged content.
 *
 * It covers the protocol version and, per edge, the edge id, the corrective task's **accepted revision** and the digest of
 * that task's content **actually present in this tree**. It deliberately does **not** cover the edge's `reason` (prose must
 * not expire a certification — the repository splits governance text from code for exactly that) or the return's
 * `recordedAt` (a no-op re-record is not a fact about what was certified).
 *
 * It also does not cover this task's own revision id: `bindsToRevision` already compares content, and it deliberately keeps
 * a verdict alive across a re-seal of **identical** content (`manifestHash` equality). Putting the subject's revision id in
 * here would expire that verdict for a reason the design does not ask for and the repository measured its way out of.
 */
export function dependencyIdentityOf(decision: {
    edges: readonly DependencyEdge[];
    corrective: readonly CorrectiveFacts[];
    returns: readonly DependencyReturn[];
}): string | null {
    if (decision.edges.length === 0) return null;
    const facts = decision.edges
        .map((edge) => {
            const corrective = decision.corrective.find((entry) => entry.taskId === edge.correctiveTaskId);
            const returned = edge.relationId === null
                ? undefined
                : decision.returns.find((entry) => entry.relationId === edge.relationId);
            return [
                edge.relationId ?? '<legacy>',
                edge.correctiveTaskId,
                corrective?.revisionId ?? '<none>',
                returned?.integratedContentHash ?? '<none>',
            ].join('\u0000');
        })
        // Sorted, so the identity describes the *set* of dependencies rather than the order the graph happened to store them in.
        .sort();
    return createHash('sha256')
        .update(JSON.stringify({ protocol: DEPENDENCY_PROTOCOL, edges: facts }))
        .digest('hex');
}

/** Which generations moved between two snapshots, named so the refusal can say what changed under it. */
export function movedGenerations(before: DependencyGeneration, after: DependencyGeneration): string[] {
    const moved: string[] = [];
    if (before.graphUpdatedAt !== after.graphUpdatedAt) {
        moved.push(`the relation graph (updatedAt ${before.graphUpdatedAt} -> ${after.graphUpdatedAt})`);
    }
    if (before.returnsUpdatedAt !== after.returnsUpdatedAt) {
        moved.push(`the dependency return record (updatedAt ${before.returnsUpdatedAt ?? '<none>'} -> ${after.returnsUpdatedAt ?? '<none>'})`);
    }
    if (before.subjectRevisionId !== after.subjectRevisionId) {
        moved.push(`this task's own revision (${before.subjectRevisionId ?? '<none>'} -> ${after.subjectRevisionId ?? '<none>'})`);
    }
    for (const [correctiveTaskId, revisionId] of Object.entries(before.correctiveRevisionIds)) {
        if (after.correctiveRevisionIds[correctiveTaskId] !== revisionId) {
            moved.push(`the corrective task '${correctiveTaskId}' (revision ${revisionId ?? '<none>'} -> ${after.correctiveRevisionIds[correctiveTaskId] ?? '<none>'})`);
        }
    }
    return moved;
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
        touchesCertificationMachinery: certificationSurfaceFor(revision?.ownedPaths ?? []).map((entry) => entry.path),
        taskReadState: state.kind === 'unreadable' ? 'unreadable' : state.kind === 'absent' ? 'absent' : 'usable',
        phase: state.kind === 'current' ? state.state.phase : null,
        revisionReadState: revisionRead.kind === 'unreadable' ? 'unreadable' : revisionRead.kind === 'absent' ? 'absent' : 'current',
        revisionId: revision?.id ?? null,
        judgedPass,
        reviewedApproved,
        integratedContentHash,
    };
}

/**
 * **How many times a read may be assembled before it is reported as unanswerable.**
 *
 * Two: one to read, one to recover from a writer that landed mid-read — the common case, and retrying it costs nothing.
 * A third would be a spin, and a read that keeps losing the race is a fact worth reporting rather than hiding behind
 * retries: `undetermined` refuses the same entries as `pending`, so the conservative answer is always available.
 */
const DEPENDENCY_READ_ATTEMPTS = 2;

/**
 * **The version of the dependency protocol a verdict was certified under.**
 *
 * It is part of the identity because the *meaning* of "the dependency is satisfied" can change while every edge and digest
 * stays byte-identical — a later kata that decides a return differently must not inherit a verdict made under this one. A
 * bump here therefore expires verdicts deliberately, which is the point: it is the one place that decision can be made.
 */
export const DEPENDENCY_PROTOCOL = 'task-dependency@1';

/** Read this task's dependency decision from the repository. The one reader every governed entry and `status` uses. */
export async function readTaskDependency(root: string, taskId: string): Promise<TaskDependencyDecision> {
    assertValidTaskId(taskId);
    let lastEdges: DependencyEdge[] = [];
    let lastSubjectRevisionId: string | null = null;
    let lastMoved: string[] = [];

    for (let attempt = 1; attempt <= DEPENDENCY_READ_ATTEMPTS; attempt += 1) {
        const graph = await readKataRelations(root);
        const edges = dependencyEdgesFor(graph.relations, taskId);
        const subject = await readCurrentTaskRevisionState(root, taskId);
        const subjectRevisionId = subject.kind === 'current' ? subject.revision.id : null;
        lastEdges = edges;
        lastSubjectRevisionId = subjectRevisionId;
        // No edge claims anything: there is nothing for a mixed-generation read to mix, so this returns without the extra
        // reads — and an edge-less task stays exactly as cheap as it was.
        if (edges.length === 0) {
            return { taskId, state: 'absent', edges: [], blockers: [], subjectRevisionId, dependencyIdentity: null };
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
                dependencyIdentity: dependencyIdentityOf({ edges, corrective: [], returns: [] }),
            };
        }

        const corrective: CorrectiveFacts[] = [];
        for (const edge of edges) {
            corrective.push(await readCorrectiveFacts(root, edge.correctiveTaskId));
        }
        // This task's own judge record, read here so the decision stays a pure function of its inputs. A record that cannot
        // be read is handed in as `null`, which `speaksForDependency` refuses — a damaged record is not a certification.
        const subjectJudge = await readValidatedOptional<{ dependencyIdentity?: string }>('judge-result', judgePath(root, taskId))
            .catch(() => null);

        // **The generations, compared before the answer is used.** The values here are the ones the answer already read —
        // the graph's `updatedAt` from the read that produced the edges, the return record's from its own read, the revision
        // pointers from the facts — so this cannot disagree with what was decided; it can only say whether it still holds.
        const before: DependencyGeneration = {
            graphUpdatedAt: graph.updatedAt,
            returnsUpdatedAt: returnsRead.updatedAt,
            subjectRevisionId,
            correctiveRevisionIds: Object.fromEntries(corrective.map((facts) => [facts.taskId, facts.revisionId])),
        };
        const after = await readDependencyGeneration(root, taskId, edges.map((edge) => edge.correctiveTaskId));
        const moved = movedGenerations(before, after);
        if (moved.length === 0) {
            return decideTaskDependencies({
                taskId,
                edges,
                corrective,
                returns: returnsRead.returns,
                subjectRevisionId,
                subjectJudge,
            });
        }
        lastMoved = moved;
    }

    // **A read that keeps losing the race is reported, not answered.** `undetermined` is the design's state for "the facts
    // could not be established", and it refuses exactly what `pending` refuses — so the conservative answer is the honest
    // one, and the operator's road is to ask again once the writers have stopped.
    return {
        taskId,
        state: 'undetermined',
        edges: lastEdges,
        // **No identity can be established from a read that never settled**, and `null` is the honest value: this decision
        // refuses every governed entry, so no verdict can be stamped from it, and a verdict stamped from some other reading
        // will not speak for the identity that is eventually established — which is the conservative direction.
        dependencyIdentity: null,
        blockers: lastEdges.map((edge) => blocker({
            edge,
            state: 'undetermined',
            reason: 'records_moved_while_reading',
            detail: `This dependency could not be read as one state: ${lastMoved.join('; ')} changed while it was being read, twice.`,
            road: `kata-cli dependency status --change ${taskId}`,
        })),
        subjectRevisionId: lastSubjectRevisionId,
    };
}

/**
 * **The identity a verdict about this task must name, read from the repository.**
 *
 * `null` when no edge claims the task, which is what makes "no dependency" distinguishable from "a dependency nobody
 * stamped": a caller compares with `speaksForDependency`, where `null` means the question does not apply.
 */
export async function dependencyIdentityFor(root: string, taskId: string): Promise<string | null> {
    return (await readTaskDependency(root, taskId)).dependencyIdentity;
}

/** Re-read just the generations, without re-reading the facts they guard. */
async function readDependencyGeneration(root: string, taskId: string, correctiveTaskIds: readonly string[]): Promise<DependencyGeneration> {
    const graph = await readKataRelations(root);
    const returnsRead = await readDependencyReturns(root, taskId);
    const subject = await readCurrentTaskRevisionState(root, taskId);
    const correctiveRevisionIds: Record<string, string | null> = {};
    for (const correctiveTaskId of correctiveTaskIds) {
        const revisionRead = await readCurrentTaskRevisionState(root, correctiveTaskId);
        correctiveRevisionIds[correctiveTaskId] = revisionRead.kind === 'current' ? revisionRead.revision.id : null;
    }
    return {
        graphUpdatedAt: graph.updatedAt,
        returnsUpdatedAt: returnsRead.kind === 'unreadable' ? null : returnsRead.updatedAt,
        subjectRevisionId: subject.kind === 'current' ? subject.revision.id : null,
        correctiveRevisionIds,
    };
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
    const edges = dependencyEdgesFor(graph.relations, taskId);
    const edge = edges.find((candidate) => candidate.relationId === relationId);
    if (!edge) {
        // **A legacy edge exists but has no id, and saying "no edge" about it is the misdirection this class is made of.**
        const legacy = edges.find((candidate) => candidate.relationId === null);
        throw new Error(legacy
            ? `The edge blocking '${taskId}' on '${legacy.correctiveTaskId}' carries no relation id, so it cannot be named by one: it was `
                + `written before edges had ids. Migrate it first, then record the return against the id that mints: ${legacyEdgeRoad(taskId, legacy)}`
            : `No task-to-task blocking edge '${relationId}' starts at '${taskId}'; read them with \`kata-cli dependency status --change ${taskId}\`.`);
    }
    const facts = await readCorrectiveFacts(root, edge.correctiveTaskId);
    if (facts.revisionId === null || facts.revisionReadState !== 'current') {
        throw new Error(`Cannot record a return for edge '${relationId}': the corrective task '${edge.correctiveTaskId}' has no readable accepted revision.`);
    }
    if (facts.touchesCertificationMachinery.length > 0) {
        throw new Error(
            `The corrective task '${edge.correctiveTaskId}' edits the machinery that decides whether it is certified `
            + `(${facts.touchesCertificationMachinery.join(', ')}), so it cannot sign the receipt that unblocks '${input.taskId}'. `
            + `Roads: ${certifierRoad(edge.correctiveTaskId)}.`,
        );
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

