import type { InitiativeProjection } from '../core/initiative-lifecycle.js';
import type { KataRelationWithLegacyId, KataRelationsGraph, RelationEndpoint } from '../core/relations.js';

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

export type FindingRevalidation = {
    findingId: string;
    revisionId: string;
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
    revalidations?: readonly FindingRevalidation[];
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

        const revision = input.revisions.find((entry) => entry.taskId === taskEnd.id);
        if (!revision) continue;

        for (const design of input.designs) {
            const declared = declaredPaths(design);
            if (declared.size === 0) {
                // A design that declares no dependency surface cannot be shown unaffected, so it is not reported as such.
                statusByDesign[design.designId] = 'undetermined';
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

    // A transferred finding is unresolved until its successor's result was revalidated against the current revision AND
    // the packet that carries that result was consumed. Both halves are required: a revalidation with an unconsumed
    // packet is a result nobody has read yet, and a consumed packet without a revalidation is a receipt for a check that
    // was never re-run.
    const revalidated = new Set((input.revalidations ?? []).map((entry) => entry.findingId));
    const unresolvedFindings = Object.entries(input.projection.findings)
        .filter(([findingId, state]) => state.status === 'transferred' && !(revalidated.has(findingId) && input.projection.consumedPacketIds.length > 0))
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
