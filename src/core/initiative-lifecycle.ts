import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
    impactPacketsPath,
    initiativeDir,
    initiativeEventsPath,
    initiativeProjectionPath,
    retirementProposalsPath,
} from './layout.js';
import { withRepositoryArtefactLock } from './locks.js';
import { readKataRelations, type KataRelationsGraph, type KataRelationWithLegacyId } from './relations.js';
import { validate } from './schema.js';
import { writeFileAtomic } from './state.js';

/**
 * **The lifecycle history of one Initiative, and the projection derived from it.**
 *
 * Two decisions are load-bearing here, and both come from defects this repository has already paid for.
 *
 * The events are the record and `current.json` is a view of them. A projection that could disagree with the events would
 * be a second answer to "what state is this design in", so every read re-derives the projection from the events rather
 * than trusting the file — the file exists so an operator can look, not so a reader can skip the history.
 *
 * An event naming a relation is checked against the graph at the moment it is appended. The relation graph is the one
 * topology, so a lifecycle record that points at an edge which does not exist is not a historical curiosity — it is a
 * binding that has silently stopped meaning anything, which is precisely what the stable relation id was introduced to
 * prevent. It is refused rather than stored.
 */

export type LifecycleEventType =
    | 'initiative_created'
    | 'design_needs_reassessment'
    | 'design_rebased'
    | 'design_invalidated'
    | 'impact_packet_recorded'
    | 'impact_packet_consumed'
    | 'finding_transferred'
    | 'finding_revalidated'
    | 'retirement_proposed'
    | 'retirement_confirmed'
    | 'initiative_closed'
    | 'post_closure_impact';

export type LifecycleEvent = {
    id: string;
    at: string;
    type: LifecycleEventType;
    /** The relation this event is about, when it is about one. Checked against the graph before the event is stored. */
    relationId?: string;
    initiativeId?: string;
    designId?: string;
    packetId?: string;
    findingId?: string;
    sliceId?: string;
    reason?: string;
    by?: string;
    result?: 'fresh' | 'needs_reassessment' | 'invalidated' | 'blocked' | 'undetermined';
    revisionId?: string;
};

export type LifecycleEventInput = Omit<LifecycleEvent, 'id' | 'at'> & { at?: string; id?: string };

/** What the current projection says — always derived, never authoritative on its own. */
export type InitiativeProjection = {
    initiativeId: string;
    status: 'active' | 'needs_reconciliation' | 'closed';
    designs: Record<string, { status: 'active' | 'needs_reassessment' | 'invalidated' | 'retired'; reason?: string }>;
    findings: Record<string, { status: 'open' | 'transferred' | 'revalidated' | 'retired' }>;
    /** Packets recorded but not yet consumed: an unconsumed packet is what blocks closure. */
    openPacketIds: string[];
    consumedPacketIds: string[];
    retired: string[];
    candidates: Array<{ kind: 'reconciliation_slice'; reason: string }>;
};

export type ClosureBlocker = {
    kind: 'unconsumed_packet' | 'needs_reassessment' | 'unresolved_return' | 'open_blocks' | 'undetermined' | 'unfinished_slice';
    detail: string;
};

export type InitiativeClosureInput = {
    initiativeId: string;
    graph: KataRelationsGraph;
    projection: InitiativeProjection;
};

export type InitiativeClosureDecision = {
    allowed: boolean;
    blockers: ClosureBlocker[];
};

export type InitiativeReadState = 'absent' | 'usable' | 'unreadable';

export type InitiativeLifecycle = {
    readState: InitiativeReadState;
    current: InitiativeProjection;
    history: LifecycleEvent[];
};
export type RetirementProposal = {
    id: string;
    initiativeId: string;
    sliceId: string;
    reason: string;
    blockers: string[];
    at: string;
};

export type RetirementBlockers = { blockers: string[] };

/**
 * **Why a slice cannot be retired right now.**
 *
 * Three facts, all read from the projection and the graph rather than from a caller's claim: an unconsumed impact
 * packet (somebody has not looked at what this slice changed), an unresolved transferred finding (a promise is still
 * outstanding), and an open `blocks` relation (the slice is load-bearing). The check is shared by proposal and
 * confirmation so the operator is told the same thing at both ends — a proposal that would be refused on confirmation
 * is worse than a refusal.
 */
export async function retirementBlockers(root: string, initiativeId: string, sliceId: string): Promise<string[]> {
    const state = await readInitiativeLifecycle(root, initiativeId);
    const blockers: string[] = [];
    if (state.current.openPacketIds.length > 0) {
        blockers.push(`unconsumed impact packet(s): ${state.current.openPacketIds.join(', ')}`);
    }
    const unresolved = Object.entries(state.current.findings)
        .filter(([, finding]) => finding.status === 'transferred')
        .map(([findingId]) => findingId);
    if (unresolved.length > 0) blockers.push(`unresolved transferred finding(s): ${unresolved.join(', ')}`);
    const graph = await readKataRelations(root);
    const openBlocks = graph.relations.filter(
        (relation) => relation.lifecycle?.policy === 'blocks' && relation.to.type === 'task' && relation.to.id === sliceId
    );
    if (openBlocks.length > 0) blockers.push(`open blocks relation(s): ${openBlocks.map((relation) => relation.id).join(', ')}`);
    return blockers;
}

export async function proposeRetirement(
    root: string,
    initiativeId: string,
    input: { sliceId: string; reason?: string }
): Promise<RetirementProposal> {
    const blockers = await retirementBlockers(root, initiativeId, input.sliceId);
    if (blockers.length > 0) {
        throw new Error(`Cannot retire '${input.sliceId}': ${blockers.join('; ')}.`);
    }
    const proposal: RetirementProposal = {
        id: `retirement-${Date.now().toString(36)}`,
        initiativeId,
        sliceId: input.sliceId,
        reason: input.reason ?? 'superseded',
        blockers: [],
        at: new Date().toISOString(),
    };
    await appendLifecycleEvent(root, initiativeId, {
        type: 'retirement_proposed',
        sliceId: input.sliceId,
        reason: proposal.reason,
    });
    await mkdir(dirname(retirementProposalsPath(root, initiativeId)), { recursive: true });
    await appendFile(retirementProposalsPath(root, initiativeId), `${JSON.stringify(proposal)}${String.fromCharCode(10)}`, 'utf8');
    return proposal;
}

/**
 * Confirm a proposal, re-checking eligibility against the state as it is **now**.
 *
 * A confirmation is the moment the decision takes effect, so it is the moment the facts have to hold. Between the
 * proposal and the confirmation a packet can arrive or a finding can be routed, and retiring on the strength of a stale
 * proposal would be the system acting on a reading it has already replaced.
 */
export async function confirmRetirement(
    root: string,
    initiativeId: string,
    input: { proposalId: string; confirmedBy: string }
): Promise<InitiativeProjection> {
    const raw = await readFile(retirementProposalsPath(root, initiativeId), 'utf8').catch(() => '');
    const proposals = raw
        .split(String.fromCharCode(10))
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as RetirementProposal);
    const proposal = proposals.find((entry) => entry.id === input.proposalId);
    if (!proposal) throw new Error(`No retirement proposal '${input.proposalId}' exists for ${initiativeId}.`);

    const blockers = await retirementBlockers(root, initiativeId, proposal.sliceId);
    if (blockers.length > 0) {
        throw new Error(`The proposal is no longer eligible for '${proposal.sliceId}': ${blockers.join('; ')}.`);
    }
    await appendLifecycleEvent(root, initiativeId, {
        type: 'retirement_confirmed',
        sliceId: proposal.sliceId,
        reason: proposal.reason,
        by: input.confirmedBy,
    });
    const state = await readInitiativeLifecycle(root, initiativeId);
    return state.current;
}

/** Re-exported so a caller can name the file a trigger wrote without importing the layout module. */
export { initiativeEventsPath } from './layout.js';

export { initiativeDir, impactPacketsPath, retirementProposalsPath };

function emptyProjection(initiativeId: string): InitiativeProjection {
    return {
        initiativeId,
        status: 'active',
        designs: {},
        findings: {},
        openPacketIds: [],
        consumedPacketIds: [],
        retired: [],
        candidates: [],
    };
}

/**
 * Read each JSONL line, counting the ones that do not parse.
 *
 * A malformed line is **counted, not thrown away**: an unreadable audit trail is a fact the caller has to see, and the
 * one thing it must never be is indistinguishable from a trail nobody wrote. That distinction is the whole reason this
 * returns a count instead of a filtered list.
 */
function parseJsonLines(text: string): { entries: Record<string, unknown>[]; malformed: number } {
    const entries: Record<string, unknown>[] = [];
    let malformed = 0;
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
            entries.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
            malformed += 1;
        }
    }
    return { entries, malformed };
}

async function readJsonLines(path: string): Promise<{ entries: Record<string, unknown>[]; malformed: number; read: boolean }> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { entries: [], malformed: 0, read: true };
        }
        return { entries: [], malformed: 1, read: false };
    }
    return { ...parseJsonLines(raw), read: true };
}

/** Derive the projection from the events, which is what makes it impossible for the two to disagree. */
function projectFrom(initiativeId: string, events: readonly LifecycleEvent[]): InitiativeProjection {
    const projection = emptyProjection(initiativeId);
    const open = new Set<string>();
    for (const event of events) {
        switch (event.type) {
            case 'initiative_created':
                projection.status = 'active';
                break;
            case 'design_needs_reassessment':
                if (event.designId) {
                    projection.designs[event.designId] = {
                        status: 'needs_reassessment',
                        ...(event.reason ? { reason: event.reason } : {}),
                    };
                }
                break;
            case 'design_rebased':
                if (event.designId) {
                    projection.designs[event.designId] = { status: 'active' };
                }
                break;
            case 'design_invalidated':
                if (event.designId) {
                    projection.designs[event.designId] = {
                        status: 'invalidated',
                        ...(event.reason ? { reason: event.reason } : {}),
                    };
                }
                break;
            case 'finding_transferred':
                if (event.findingId) projection.findings[event.findingId] = { status: 'transferred' };
                break;
            case 'finding_revalidated':
                // Legacy incomplete events remain readable but cannot close a finding; new writes are checked by
                // assertCurrentFindingRevalidation before they reach this projection.
                if (event.findingId && event.relationId && event.revisionId && event.packetId) {
                    projection.findings[event.findingId] = { status: 'revalidated' };
                }
                break;
            case 'impact_packet_recorded':
                if (event.packetId) open.add(event.packetId);
                break;
            case 'impact_packet_consumed':
                if (event.packetId) {
                    open.delete(event.packetId);
                    if (!projection.consumedPacketIds.includes(event.packetId)) projection.consumedPacketIds.push(event.packetId);
                }
                break;
            case 'retirement_confirmed':
                if (event.sliceId && !projection.retired.includes(event.sliceId)) projection.retired.push(event.sliceId);
                break;
            case 'initiative_closed':
                projection.status = 'closed';
                break;
            case 'post_closure_impact':
                // **The closure is not rewritten; the projection moves.** The historical `initiative_closed` event stays
                // exactly where it was, and what changes is the current view plus the candidate it produces.
                projection.status = 'needs_reconciliation';
                projection.candidates.push({ kind: 'reconciliation_slice', reason: event.reason ?? 'related work changed after closure' });
                break;
            default:
                break;
        }
    }
    projection.openPacketIds = [...open];
    return projection;
}

/**
 * The lifecycle of one Initiative, read from its own directory.
 *
 * Three states, because "not created yet" and "present but unreadable" are different answers with different remedies —
 * the same three-way rule every other record reader in this repository follows.
 */
export async function readInitiativeLifecycle(root: string, initiativeId: string): Promise<InitiativeLifecycle> {
    const events = await readJsonLines(initiativeEventsPath(root, initiativeId));
    const packets = await readJsonLines(impactPacketsPath(root, initiativeId));
    if (!events.read || !packets.read) return { readState: 'unreadable', current: emptyProjection(initiativeId), history: [] };
    if (events.malformed > 0 || packets.malformed > 0) return { readState: 'unreadable', current: emptyProjection(initiativeId), history: [] };
    if (events.entries.length === 0) return { readState: 'absent', current: emptyProjection(initiativeId), history: [] };

    const history: LifecycleEvent[] = [];
    for (const entry of events.entries) {
        try {
            history.push(validate<LifecycleEvent>('initiative-lifecycle', entry));
        } catch {
            return { readState: 'unreadable', current: emptyProjection(initiativeId), history: [] };
        }
    }
    const packetEntries: LifecycleEvent[] = [];
    for (const entry of packets.entries) {
        try {
            packetEntries.push(validate<LifecycleEvent>('initiative-lifecycle', entry));
        } catch {
            return { readState: 'unreadable', current: emptyProjection(initiativeId), history: [] };
        }
    }
    // The recorded packets are part of the same history: whether one has been consumed is a lifecycle fact, and reading
    // them from a second file only matters because a packet is written once and never rewritten.
    return { readState: 'usable', current: projectFrom(initiativeId, [...history, ...packetEntries]), history: [...history, ...packetEntries] };
}

function componentEdges(graph: KataRelationsGraph, initiativeId: string): KataRelationWithLegacyId[] {
    const start = `change:${initiativeId}`;
    const reachable = new Set<string>([start]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const relation of graph.relations) {
            const endpoints = [`${relation.from.type}:${relation.from.id}`, `${relation.to.type}:${relation.to.id}`];
            if (!endpoints.some((endpoint) => reachable.has(endpoint))) continue;
            for (const endpoint of endpoints) {
                if (!reachable.has(endpoint)) {
                    reachable.add(endpoint);
                    changed = true;
                }
            }
        }
    }
    return graph.relations.filter((relation) =>
        reachable.has(`${relation.from.type}:${relation.from.id}`)
        && reachable.has(`${relation.to.type}:${relation.to.id}`)
    );
}

/** The one closure decision: every writer must use this evaluator rather than reconstruct its own blocker list. */
export function evaluateInitiativeClosure(input: InitiativeClosureInput): InitiativeClosureDecision {
    const blockers: ClosureBlocker[] = [];
    for (const packetId of input.projection.openPacketIds) {
        blockers.push({ kind: 'unconsumed_packet', detail: `impact packet '${packetId}' was recorded but never consumed` });
    }
    for (const [designId, design] of Object.entries(input.projection.designs)) {
        if (design.status === 'needs_reassessment' || design.status === 'invalidated') {
            blockers.push({ kind: 'needs_reassessment', detail: `design '${designId}' is ${design.status}${design.reason ? `: ${design.reason}` : ''}` });
        }
    }
    for (const [findingId, finding] of Object.entries(input.projection.findings)) {
        if (finding.status === 'transferred') {
            blockers.push({ kind: 'unresolved_return', detail: `finding '${findingId}' was transferred and has not been revalidated against the current revision` });
        }
    }
    for (const relation of componentEdges(input.graph, input.initiativeId)) {
        if (relation.lifecycle?.policy === 'blocks') {
            blockers.push({ kind: 'open_blocks', detail: `relation '${relation.id ?? 'unknown'}' still blocks this Initiative` });
        }
        if (!relation.lifecycle) {
            blockers.push({ kind: 'undetermined', detail: `relation with ${relation.to.type}:${relation.to.id} carries no lifecycle metadata, so nothing about it could be evaluated` });
        }
    }
    return { allowed: blockers.length === 0, blockers };
}

/**
 * Append ordinary lifecycle history. Closure is deliberately excluded: it has its own authority below so it cannot
 * bypass the evaluator by looking like an ordinary audit event.
 */
async function assertCurrentFindingRevalidation(root: string, initiativeId: string, input: LifecycleEventInput): Promise<void> {
    if (!input.findingId || !input.relationId || !input.revisionId || !input.packetId) {
        throw new Error('A finding revalidation must name its finding, relation, current revision and packet.');
    }
    const graph = await readKataRelations(root);
    const relation = graph.relations.find((entry) => entry.id === input.relationId);
    if (relation?.lifecycle?.policy !== 'implements_finding' || !relation.lifecycle.sourceFindingIds?.includes(input.findingId)) {
        throw new Error(`Finding '${input.findingId}' is not transferred by lifecycle relation '${input.relationId}'.`);
    }
    const expectedPacketId = `${input.relationId}:${input.revisionId}`;
    if (input.packetId !== expectedPacketId) {
        throw new Error(`Finding '${input.findingId}' revalidation packet does not bind relation '${input.relationId}' to revision '${input.revisionId}'.`);
    }
    const lifecycle = await readInitiativeLifecycle(root, initiativeId);
    const newestPacket = [...lifecycle.history].reverse().find((event) =>
        event.type === 'impact_packet_recorded' && event.relationId === input.relationId
    );
    if (newestPacket?.packetId !== input.packetId || !lifecycle.current.consumedPacketIds.includes(input.packetId)) {
        throw new Error(`Finding '${input.findingId}' revalidation must answer the current consumed successor packet.`);
    }
}


export async function appendLifecycleEvent(root: string, initiativeId: string, input: LifecycleEventInput): Promise<LifecycleEvent> {
    if (input.type === 'initiative_closed') {
        throw new Error('Initiative closure must go through closeInitiative so every closure blocker is evaluated.');
    }
    if (input.type === 'finding_revalidated') {
        await assertCurrentFindingRevalidation(root, initiativeId, input);
    }
    return appendLifecycleEventInternal(root, initiativeId, input);
}

/** Evaluate the exact graph/projection before the one write that records a closure. */
export async function closeInitiative(
    root: string,
    input: InitiativeClosureInput & { reason?: string }
 ): Promise<InitiativeProjection> {
    const decision = evaluateInitiativeClosure(input);
    if (!decision.allowed) {
        throw new Error(`Cannot close Initiative '${input.initiativeId}': ${decision.blockers.map((blocker) => blocker.detail).join('; ')}.`);
    }
    await appendLifecycleEventInternal(root, input.initiativeId, {
        type: 'initiative_closed',
        reason: input.reason,
    });
    return (await readInitiativeLifecycle(root, input.initiativeId)).current;
}


/**
 * Append one lifecycle event, and refuse it if it names a relation the graph does not have.
 *
 * The relation check is the reason this cannot be a plain append: an event bound to a vanished edge would read later as
 * a fact about an edge that is not there, and the misreading is silent.
 */
async function appendLifecycleEventInternal(root: string, initiativeId: string, input: LifecycleEventInput): Promise<LifecycleEvent> {
    if (input.relationId) {
        const graph = await readKataRelations(root);
        const known = graph.relations.some((relation) => relation.id === input.relationId);
        if (!known) {
            throw new Error(
                `Lifecycle event names relation '${input.relationId}', which the relation graph does not contain; a lifecycle record bound to a missing edge stops meaning anything, so it is refused rather than stored.`
            );
        }
    }
    const event: LifecycleEvent = {
        id: input.id ?? `lifecycle-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        at: input.at ?? new Date().toISOString(),
        ...input,
    };
    validate<LifecycleEvent>('initiative-lifecycle', event);

    // **The directory exists before the lock writes into it.** The lock writes the file directly and does not create the
    // parent, so a first event on a fresh Initiative would fail on a path nobody had made yet — measured as `ENOENT` on
    // the lock's own temporary file.
    await mkdir(dirname(initiativeEventsPath(root, initiativeId)), { recursive: true });
    await withRepositoryArtefactLock(root, `initiative-${initiativeId}`, initiativeEventsPath(root, initiativeId), async (current) => {
        // **The lock hands back the current bytes, so the history is appended rather than replaced.** Returning only the
        // new line would drop every event already in the file, which is the one thing an append-only trail must not do.
        // The lock is repository-scoped rather than task-scoped because an Initiative spans tasks, which is what it is for.
        return `${current}${JSON.stringify(event)}` + String.fromCharCode(10);
    });

    // Projection after the event, re-derived from the whole history rather than patched, so the two cannot drift.
    const state = await readInitiativeLifecycle(root, initiativeId);
    await mkdir(dirname(initiativeProjectionPath(root, initiativeId)), { recursive: true });
    await writeFileAtomic(initiativeProjectionPath(root, initiativeId), `${JSON.stringify(state.current, null, 2)}\n`);
    return event;
}

/**
 * Append a run of events, used by the reconciliation writer.
 *
 * It exists so callers append **through the checked path** — an `appendFile` beside this module would bypass the relation
 * binding check, which is the shape this repository keeps finding: a rule with one writer that a second writer skips.
 */
export async function appendLifecycleEvents(root: string, initiativeId: string, inputs: readonly LifecycleEventInput[]): Promise<LifecycleEvent[]> {
    const appended: LifecycleEvent[] = [];
    for (const input of inputs) appended.push(await appendLifecycleEvent(root, initiativeId, input));
    return appended;
}

/** Exported for the writers that must append many lines under one lock; kept beside the reader of the same file. */
export async function appendPacketLines(root: string, initiativeId: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    const path = impactPacketsPath(root, initiativeId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
}
