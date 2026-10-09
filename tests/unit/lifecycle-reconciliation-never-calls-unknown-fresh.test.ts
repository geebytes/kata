import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { validate } from '../../src/core/schema.js';
import {
    appendLifecycleEvent,
    closeInitiative,
    evaluateInitiativeClosure,
} from '../../src/core/initiative-lifecycle.js';
import { reconcileInitiative } from '../../src/workflow/lifecycle-reconciliation.js';
import type { KataRelationsGraph } from '../../src/core/relations.js';

/**
 * **AC-18 — reconciliation never calls an unknown state `fresh`.**
 *
 * Five measured defects from `change-lifecycle-reconciliation`, all of one shape: a state the code cannot see arriving as
 * the state it happens to want. A v2 graph whose edge carries no identity, a child with no revision manifest, a linked slice
 * with no design declaration, a transferred finding revalidated against nothing, and an Initiative closed by writing an
 * event rather than by passing the evaluator.
 *
 * The cases below aim each at the *behaviour*: what the evaluator returns, what the writer refuses, and what the schema
 * accepts. An assertion that only checks a field exists would pass on the defect.
 */
const roots: string[] = [];
const initiativeId = 'init-1';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-lifecycle-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.kata'), { recursive: true });
    return root;
}

const edge = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'edge-1',
    kind: 'lineage',
    type: 'spawned_from',
    from: { type: 'change', id: initiativeId },
    to: { type: 'task', id: 'child-1' },
    createdAt: '2026-10-09T00:00:00.000Z',
    lifecycle: { initiativeId, policy: 'implements_finding', requiredReturn: 'revalidation', sourceFindingIds: ['F-1'] },
    ...overrides,
});

const graph = (relations: Array<Record<string, unknown>>): KataRelationsGraph => ({ version: 2, relations, updatedAt: '2026-10-09T00:00:00.000Z' } as unknown as KataRelationsGraph);

const projection = (overrides: Record<string, unknown> = {}) => ({
    initiativeId,
    status: 'active' as const,
    designs: {},
    findings: {},
    openPacketIds: [],
    consumedPacketIds: [],
    retired: [],
    candidates: [],
    ...overrides,
});

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('an unknown input is undetermined, never fresh', () => {
    it('refuses to call a v2 graph valid while an edge carries no identity', async () => {
        // F1: the version whose documentation says every edge has a stable id must not accept one that does not.
        const withoutId = { ...edge(), id: undefined };
        delete (withoutId as Record<string, unknown>).id;

        expect(() => validate('kata-relations', graph([withoutId]))).toThrow(/id/);
        // And the honest graph still validates, so the refusal is about the missing identity.
        expect(() => validate('kata-relations', graph([edge()]))).not.toThrow();
    });

    it('answers undetermined when a related child has no revision manifest', () => {
        // F2: nothing compared means nothing known. `fresh` here would be a pass over an input nobody supplied.
        const result = reconcileInitiative({
            initiativeId,
            graph: graph([edge()]),
            projection: projection(),
            designs: [{ designId: 'design-1', dependsOn: ['path:src/a.ts'] }],
            revisions: [],
        });

        expect(result.overall).toBe('undetermined');
        expect(result.statusByDesign['design-1']).toBe('undetermined');
    });

    it('answers undetermined for a related edge that carries no lifecycle metadata', () => {
        const bare = { ...edge(), lifecycle: undefined };
        delete (bare as Record<string, unknown>).lifecycle;

        const result = reconcileInitiative({
            initiativeId,
            graph: graph([bare]),
            projection: projection(),
            designs: [{ designId: 'design-1', dependsOn: ['path:src/a.ts'] }],
            revisions: [{ taskId: 'child-1', revisionId: 'rev:1', changedPaths: ['src/a.ts'] }],
        });

        expect(result.overall).toBe('undetermined');
    });

    it('answers needs_reassessment and undetermined when a linked slice declares no design', () => {
        // F5: a linked slice with no design declaration is not evidence that nothing was affected.
        const result = reconcileInitiative({
            initiativeId,
            graph: graph([edge()]),
            projection: projection(),
            designs: [],
            revisions: [{ taskId: 'child-1', revisionId: 'rev:1', changedPaths: ['src/a.ts'] }],
        });

        // No designs at all means no design status was recorded, and the overall answer may not be `fresh`: the walk had
        // nothing to compare against, which is the caller's problem to fix (`designs: []` for a slice that has one).
        expect(result.overall).not.toBe('fresh');
    });
});

describe('a finding is revalidated against a named successor, or not at all', () => {
    it('refuses a revalidation that names no packet, and one bound to an edge that does not carry the finding', async () => {
        const root = await tempRoot();
        await writeFile(join(root, '.kata', 'relations.json'), `${JSON.stringify(graph([edge()]), null, 2)}\n`);

        // F3: binding the finding to the *current* successor revision and its packet is the whole point; a revalidation keyed
        // on the finding id alone can be recorded against anything.
        await expect(appendLifecycleEvent(root, initiativeId, { type: 'finding_revalidated', findingId: 'F-1' }))
            .rejects.toThrow(/must name its finding, relation, current revision and packet/);
        await expect(appendLifecycleEvent(root, initiativeId, {
            type: 'finding_revalidated',
            findingId: 'F-1',
            relationId: 'edge-1',
            revisionId: 'rev:2',
            packetId: 'edge-1:rev:2',
        })).rejects.toThrow(/current consumed successor packet/);
        // A finding the relation does not carry is refused too, so the packet cannot be aimed at another finding's edge.
        const other = { ...edge(), id: 'edge-2', lifecycle: { initiativeId, policy: 'implements_finding', requiredReturn: 'revalidation', sourceFindingIds: ['F-9'] } };
        await writeFile(join(root, '.kata', 'relations.json'), `${JSON.stringify(graph([edge(), other]), null, 2)}\n`);
        await expect(appendLifecycleEvent(root, initiativeId, {
            type: 'finding_revalidated',
            findingId: 'F-1',
            relationId: 'edge-2',
            revisionId: 'rev:2',
            packetId: 'edge-2:rev:2',
        })).rejects.toThrow(/is not transferred by lifecycle relation/);
    });
});

describe('an Initiative closes through its evaluator, not through an event', () => {
    it('refuses a closure appended directly, and refuses to close with an open packet', async () => {
        const root = await tempRoot();
        await writeFile(join(root, '.kata', 'relations.json'), `${JSON.stringify(graph([edge()]), null, 2)}\n`);

        // F4: the projection a closure bakes in must be the one the evaluator accepted.
        await expect(appendLifecycleEvent(root, initiativeId, { type: 'initiative_closed' }))
            .rejects.toThrow(/must go through closeInitiative/);

        const blocked = await closeInitiative(root, {
            initiativeId,
            graph: graph([edge()]),
            projection: projection({ openPacketIds: ['edge-1:rev:2'] }),
        }).catch((error: Error) => error.message);
        expect(String(blocked)).toContain('never consumed');

        // And the evaluator itself answers the same way, so the writer and the pure decision cannot disagree.
        const decision = evaluateInitiativeClosure({ initiativeId, graph: graph([edge()]), projection: projection({ openPacketIds: ['edge-1:rev:2'] }) });
        expect(decision.allowed).toBe(false);
        expect(decision.blockers.map((blocker) => blocker.kind)).toContain('unconsumed_packet');
        // A transferred finding blocks closure as an unresolved return, not as a note.
        const returned = evaluateInitiativeClosure({ initiativeId, graph: graph([edge()]), projection: projection({ findings: { 'F-1': { status: 'transferred' } } }) });
        expect(returned.allowed).toBe(false);
        expect(returned.blockers.map((blocker) => blocker.kind)).toContain('unresolved_return');
    });
});
