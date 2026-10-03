import {
    appendLifecycleEvent,
    evaluateInitiativeClosure as evaluateStoredInitiativeClosure,
    readInitiativeLifecycle,
    type InitiativeProjection,
} from '../core/initiative-lifecycle.js';
import { readKataRelations, type KataRelationWithLegacyId, type KataRelationsGraph, type RelationEndpoint } from '../core/relations.js';
import { readDesignDeclarations } from '../cli/lifecycle.js';

/**
 * **Reconciliation is a pure function of the graph, the projection and the manifests.**
 *
 * It reads nothing: the caller supplies the relation graph, the Initiative's projection, the designs' declared
 * dependencies and the revisions that moved. That is deliberate and it is what makes the cost arguable — the evaluation
 * can only look at what it was handed, so it cannot quietly scan the repository, and the bounded-work claim is a property
 * of the code rather than a promise in a comment.
 *
 * Two rules carry most of the weight.
 *
 * **`undetermined` is not `fresh`.** A relation with no lifecycle metadata, a design with no declared dependencies, or a
 * revision with no manifest is a case where the answer is not known. Returning `fresh` there would look like a pass while
 * nothing had been read — the shape of every stale-audit failure in this repository's history.
 *
 * **Unrelated work is not visited.** The walk starts at the Initiative's own endpoint and follows its edges, so an
 * unrelated Initiative in the same graph is never traversed; `visitedEndpoints` reports exactly what was walked, which is
 * what makes that observable rather than asserted.
 */

export type Freshness = 'fresh' | 'needs_reassessment' | 'invalidated' | 'blocked' | 'undetermined';

export type DesignDependency = {
    designId: string;
    /** `path:`-prefixed dependencies, matching the ledger's own dependency spelling rather than a second one. */
    dependsOn: string[];
};

export type RevisionManifest = {
    taskId: string;
    revisionId: string;
    changedPaths: string[];
};

export type ImpactPacket = {
    initiativeId: string;
    relationId: string;
    taskId: string;
    revisionId: string;
    result: Freshness;
    intersectedPaths: string[];
};

export type ReconciliationResult = {
    overall: Freshness;
    statusByDesign: Record<string, Freshness>;
    impactPackets: ImpactPacket[];
    unresolvedFindings: string[];
    /** Every endpoint the walk actually visited, so "bounded work" is measurable rather than claimed. */
    visitedEndpoints: string[];
};

export type ReconciliationInput = {
    initiativeId: string;
    graph: KataRelationsGraph;
    projection: InitiativeProjection;
    designs: readonly DesignDependency[];
    revisions: readonly RevisionManifest[];
};

/** The endpoints of the Initiative's own connected component, in a stable order. */
function componentOf(graph: KataRelationsGraph, initiativeId: string): { endpoints: string[]; edges: KataRelationWithLegacyId[] } {
    const start = `change:${initiativeId}`;
    const reachable = new Set<string>([start]);
    const edges: KataRelationWithLegacyId[] = [];
    let grew = true;
    while (grew) {
        grew = false;
        for (const relation of graph.relations) {
            const ends = [`${relation.from.type}:${relation.from.id}`, `${relation.to.type}:${relation.to.id}`];
            const touches = ends.some((end) => reachable.has(end));
            if (!touches) continue;
            if (!edges.includes(relation)) edges.push(relation);
            for (const end of ends) {
                if (!reachable.has(end)) {
                    reachable.add(end);
                    grew = true;
                }
            }
        }
    }
    // The edges of the component are those with both ends reachable; an edge with one end outside is not part of it, and
    // traversing it would be the unbounded walk this function exists to avoid.
    const inside = edges.filter((relation) =>
        reachable.has(`${relation.from.type}:${relation.from.id}`) && reachable.has(`${relation.to.type}:${relation.to.id}`)
    );
    return { endpoints: [...reachable].sort(), edges: inside };
}

/** The paths a design declares it depends on, without the `path:` prefix the ledger spells them with. */
function declaredPaths(design: DesignDependency): Set<string> {
    return new Set(design.dependsOn.filter((dep) => dep.startsWith('path:')).map((dep) => dep.slice('path:'.length)));
}

/**
 * Evaluate one Initiative, without reading anything.
 *
 * The order of the rules is the order of their strength: an unknown input makes the whole evaluation `undetermined`
 * before any comparison happens, because a comparison against a manifest nobody could read is not a weaker answer — it is
 * no answer.
 */
export function reconcileInitiative(input: ReconciliationInput): ReconciliationResult {
    const { endpoints, edges } = componentOf(input.graph, input.initiativeId);
    const statusByDesign: Record<string, Freshness> = {};
    for (const design of input.designs) statusByDesign[design.designId] = 'fresh';

    const impacted = new Map<string, string[]>();
    let undetermined = false;
    const impactPackets: ImpactPacket[] = [];

    for (const relation of edges) {
        // A related endpoint is a task; a `change:` endpoint is the Initiative side of the topology.
        const taskEnd: RelationEndpoint | undefined = [relation.from, relation.to].find((end) => end.type === 'task');
        if (!taskEnd) continue;
        if (!relation.lifecycle) {
            // **A relation with no lifecycle metadata answers nothing.** It is the ordinary `related_to` edge the graph
            // has carried since before this feature, and reading it as "no impact" is the silent pass this rule refuses.
            undetermined = true;
            for (const design of input.designs) statusByDesign[design.designId] = 'undetermined';
            continue;
        }
        if (relation.lifecycle.initiativeId !== input.initiativeId) continue;
        // **A lifecycle edge carries an identity by construction.** `addLifecycleRelation` migrates the graph before it
        // writes, so an id-less lifecycle edge means the file was hand-edited — and an impact packet that cannot name
        // the edge it answers stops meaning anything. That is `undetermined`, not a silently unnamed packet.
        if (typeof relation.id !== 'string' || relation.id.length === 0) {
            undetermined = true;
            for (const design of input.designs) statusByDesign[design.designId] = 'undetermined';
            continue;
        }

        const revision = input.revisions.find((entry) => entry.taskId === taskEnd.id);
        if (!revision) {
            // A related child with no revision manifest has changed nothing we can compare, not nothing at all.
            // The only sound answer is undetermined until its manifest is supplied.
            undetermined = true;
            for (const design of input.designs) statusByDesign[design.designId] = 'undetermined';
            continue;
        }
        for (const design of input.designs) {
            const declared = declaredPaths(design);
            if (declared.size === 0) {
                // **A design that declares no dependency surface is `needs_reassessment`, and the whole answer is
                // `undetermined`.** The two are both true and they answer different questions: this design must be
                // looked at again (nobody can show it is unaffected), and the Initiative's overall freshness cannot be
                // asserted (the comparison that would justify `fresh` was never possible). Reporting either one alone
                // would lose a fact the operator needs.
                statusByDesign[design.designId] = 'needs_reassessment';
                undetermined = true;
                continue;
            }
            const intersected = revision.changedPaths.filter((path) => declared.has(path)).sort();
            if (intersected.length === 0) continue;
            impacted.set(design.designId, intersected);
            statusByDesign[design.designId] = 'needs_reassessment';
            impactPackets.push({
                initiativeId: input.initiativeId,
                relationId: relation.id,
                taskId: taskEnd.id,
                revisionId: revision.revisionId,
                result: 'needs_reassessment',
                intersectedPaths: intersected,
            });
        }
    }

    // The lifecycle writer sets `revalidated` only after binding the finding to its relation's latest consumed
    // successor packet. The evaluator therefore reads the one projected state instead of reconstructing a second
    // return-matching algorithm from caller-supplied arrays.
    const unresolvedFindings = Object.entries(input.projection.findings)
        .filter(([, state]) => state.status === 'transferred')
        .map(([findingId]) => findingId)
        .sort();

    const statuses = Object.values(statusByDesign);
    const overall: Freshness = undetermined
        ? 'undetermined'
        : statuses.includes('invalidated')
            ? 'invalidated'
            : statuses.includes('needs_reassessment')
                ? 'needs_reassessment'
                : 'fresh';

    return { overall, statusByDesign, impactPackets, unresolvedFindings, visitedEndpoints: endpoints };
}

export type LifecycleTriggerEvent = {
    taskId: string;
    revisionId: string;
    changedPaths: string[];
};

export type LifecycleTriggerResult = {
    status: Freshness;
    packets: ImpactPacket[];
    initiatives: string[];
};

/**
 * **The one bridge from a workflow event to reconciliation.**
 *
 * The workflow calls this after a seal or a finding lands, never before: the event describes a durable state, and a
 * reconciliation against a state that was never written would produce a packet about something that did not happen.
 *
 * It reads the graph to find which Initiatives relate to this task, and evaluates only those — an unrelated Initiative
 * is never loaded, which keeps the cost proportional to the relation component rather than to the repository. The
 * filesystem-to-input mapping lives here so the evaluator above stays pure.
 */
export async function recordLifecycleTrigger(root: string, event: LifecycleTriggerEvent): Promise<LifecycleTriggerResult> {
    const graph = await readKataRelations(root);
    // **A related edge with no lifecycle metadata still names an Initiative to evaluate.** Filtering on
    // `lifecycle.initiativeId` alone would drop it and report `fresh` — the silent pass this whole rule exists to
    // refuse. The Initiative is the `change:` end of any related edge; whether that edge carries metadata is what the
    // evaluator decides, and it answers `undetermined`.
    const related = graph.relations.filter(
        (relation) => (relation.from.type === 'task' && relation.from.id === event.taskId) || (relation.to.type === 'task' && relation.to.id === event.taskId)
    );
    const initiatives = [...new Set(related.flatMap((relation) => {
        if (relation.lifecycle) return [relation.lifecycle.initiativeId];
        const changeEnd = [relation.from, relation.to].find((end) => end.type === 'change');
        return changeEnd ? [changeEnd.id] : [];
    }))].sort();

    const packets: ImpactPacket[] = [];
    let status: Freshness = 'fresh';
    for (const initiativeId of initiatives) {
        const projection = await readInitiativeLifecycle(root, initiativeId);
        if (projection.readState === 'unreadable') {
            // An unreadable lifecycle is not an empty one: reporting `fresh` here is the silent pass this refuses.
            status = 'undetermined';
            continue;
        }
        // **A closed Initiative is not re-opened by a later change; its projection moves.** The closure is a historical
        // fact, so the relay records `post_closure_impact` and the projection becomes `needs_reconciliation` with a
        // candidate — rewriting the closure event would be editing a record of something that did happen.
        if (projection.current.status === 'closed') {
            await recordPostClosureImpact(root, initiativeId, `${event.taskId} sealed ${event.revisionId} after this Initiative closed`);
            status = 'needs_reassessment';
            continue;
        }
        const designDeclarations = await readDesignDeclarations(root, initiativeId);
        if (designDeclarations.readState !== 'usable') {
            // A missing or unreadable declaration cannot prove an Initiative unaffected.
            status = 'undetermined';
            continue;
        }
        const result = reconcileInitiative({
            initiativeId,
            graph,
            projection: projection.current,
            designs: designDeclarations.designs,
            revisions: [{ taskId: event.taskId, revisionId: event.revisionId, changedPaths: event.changedPaths }],
        });
        if (result.overall === 'undetermined') status = 'undetermined';
        else if (result.overall === 'needs_reassessment' && status === 'fresh') status = 'needs_reassessment';

        for (const packet of result.impactPackets) {
            // **Recorded, not merely returned.** A packet the parent cannot see later would leave it unable to tell
            // whether the impact was ever noticed, which is the whole point of keeping it.
            await appendLifecycleEvent(root, initiativeId, {
                type: 'impact_packet_recorded',
                relationId: packet.relationId,
                packetId: `${packet.relationId}:${packet.revisionId}`,
                designId: Object.keys(result.statusByDesign).find((designId) => result.statusByDesign[designId] === 'needs_reassessment'),
                reason: `${packet.taskId} sealed ${packet.revisionId}, touching ${packet.intersectedPaths.join(', ')}`,
            });
            packets.push(packet);
        }
    }
    return { status, packets, initiatives };
}

export type { ClosureBlocker, InitiativeClosureDecision } from '../core/initiative-lifecycle.js';

/** Delegate closure evaluation to the store that owns the only closure writer. */
export function evaluateInitiativeClosure(input: ReconciliationInput) {
    return evaluateStoredInitiativeClosure({
        initiativeId: input.initiativeId,
        graph: input.graph,
        projection: input.projection,
    });
}

/**
 * After a closure, a later related change moves the projection rather than the record.
 *
 * The historical `initiative_closed` event stays exactly where it was — it is a record of something that did happen —
 * and what changes is that the Initiative is no longer current plus the candidate that says so. That distinction is the
 * whole reason the projection is derived from the events rather than being the events.
 */
export async function recordPostClosureImpact(root: string, initiativeId: string, reason: string): Promise<InitiativeProjection> {
    await appendLifecycleEvent(root, initiativeId, { type: 'post_closure_impact', reason });
    const state = await readInitiativeLifecycle(root, initiativeId);
    return state.current;
}
