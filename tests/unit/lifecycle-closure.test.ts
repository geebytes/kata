import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateInitiativeClosure } from '../../src/workflow/lifecycle-reconciliation.js';
import { appendLifecycleEvent, readInitiativeLifecycle } from '../../src/core/initiative-lifecycle.js';
import { addLifecycleRelation } from '../../src/core/relations.js';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { recordLifecycleTrigger } from '../../src/workflow/lifecycle-reconciliation.js';
import { designsPath } from '../../src/cli/lifecycle.js';

/**
 * **Closing an Initiative means every intermediate change was accounted for, and that has to be checkable.**
 *
 * The reverse scan is the part of this design that makes "the later solution considered the intermediate changes" a
 * closure *condition* rather than a sentence in a document: unsatisfied `blocks`, an unconsumed packet, a design that
 * needs reassessment, an unresolved required return, or any input nobody could read all block the closure and are named.
 *
 * The second half is what happens *after* a closure. A new related revision does not rewrite the historical closure —
 * that would be editing a record of something that did happen — it moves the **current projection** to
 * `needs_reconciliation` and produces a candidate. The two are different objects precisely so this is possible.
 */
describe('initiative closure', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function fixture(prefix: string, taskIds: string[] = ['child']) {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        await initLayout(root);
        for (const taskId of taskIds) {
            await createTask({ root, id: taskId, title: taskId, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        }
        return root;
    }

    it('refuses closure and names every unconsumed packet, stale design and unresolved return', () => {
        const decision = evaluateInitiativeClosure({
            initiativeId: 'records-initiative',
            graph: {
                version: 2,
                updatedAt: '2026-10-03T00:00:00.000Z',
                relations: [
                    {
                        id: 'edge-1',
                        kind: 'context',
                        type: 'related_to',
                        from: { type: 'change', id: 'records-initiative' },
                        to: { type: 'task', id: 'child' },
                        createdAt: '2026-10-03T00:00:00.000Z',
                        lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
                    },
                ],
            },
            projection: {
                initiativeId: 'records-initiative',
                status: 'active',
                designs: { 'parent-design': { status: 'needs_reassessment' } },
                findings: { 'F-1': { status: 'transferred' } },
                openPacketIds: ['packet-1'],
                consumedPacketIds: [],
                retired: [],
                candidates: [],
            },
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            revisions: [],
        });

        expect(decision.allowed).toBe(false);
        expect(decision.blockers.map((blocker) => blocker.kind)).toEqual(
            expect.arrayContaining(['unconsumed_packet', 'needs_reassessment', 'unresolved_return'])
        );
    });

    it('allows closure when nothing is outstanding', () => {
        const decision = evaluateInitiativeClosure({
            initiativeId: 'records-initiative',
            graph: {
                version: 2,
                updatedAt: '2026-10-03T00:00:00.000Z',
                relations: [
                    {
                        id: 'edge-1',
                        kind: 'context',
                        type: 'related_to',
                        from: { type: 'change', id: 'records-initiative' },
                        to: { type: 'task', id: 'child' },
                        createdAt: '2026-10-03T00:00:00.000Z',
                        lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
                    },
                ],
            },
            projection: {
                initiativeId: 'records-initiative',
                status: 'active',
                designs: {},
                findings: {},
                openPacketIds: [],
                consumedPacketIds: ['packet-1'],
                retired: [],
                candidates: [],
            },
            designs: [],
            revisions: [],
        });

        expect(decision).toEqual({ allowed: true, blockers: [] });
    });


});
