import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmRetirement, proposeRetirement } from '../../src/core/initiative-lifecycle.js';
import { addLifecycleRelation } from '../../src/core/relations.js';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { appendLifecycleEvent, readInitiativeLifecycle } from '../../src/core/initiative-lifecycle.js';
import { designsPath } from '../../src/cli/lifecycle.js';

/**
 * **Retirement is a decision an operator confirms, and it never deletes anything.**
 *
 * Two rules, and both are about the difference between "no longer active" and "no longer true".
 *
 * A slice may not be retired while something it still owes is outstanding — a blocking finding, an unconsumed impact
 * packet, or an open `blocks` edge. That is the half the system can check, and it is checked at *proposal* time so the
 * operator is told why rather than handed a proposal that will be refused.
 *
 * Confirming removes the slice from the **active projection only**. The history keeps every event, including the ones
 * that made it retirable, because a retirement whose reasons have been deleted cannot be reviewed.
 */
describe('initiative retirement', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function fixture(prefix: string, options: { openPacket?: boolean; blockingFinding?: boolean; openBlocks?: boolean } = {}) {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'obsolete-slice', title: 'obsolete', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'obsolete-slice' },
            type: 'related_to',
            lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });
        const relationId = graph.relations[0]?.id as string;
        await appendLifecycleEvent(root, 'records-initiative', { type: 'initiative_created', initiativeId: 'records-initiative' });
        if (options.openPacket) {
            await appendLifecycleEvent(root, 'records-initiative', {
                type: 'impact_packet_recorded', relationId, packetId: 'packet-open',
            });
        }
        if (options.blockingFinding) {
            await appendLifecycleEvent(root, 'records-initiative', {
                type: 'finding_transferred', relationId, findingId: 'F-blocking',
            });
        }
        if (options.openBlocks) {
            await addLifecycleRelation({
                root,
                from: { type: 'change', id: 'records-initiative' },
                to: { type: 'task', id: 'obsolete-slice' },
                type: 'blocked_by',
                lifecycle: { initiativeId: 'records-initiative', policy: 'blocks', requiredReturn: 'none' },
            });
        }
        await writeFile(designsPath(root, 'records-initiative'), `${JSON.stringify({
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
        })}\n`, 'utf8');
        return { root, relationId };
    }

    it.each([
        ['an unconsumed packet', { openPacket: true }],
        ['a transferred finding that is still unresolved', { blockingFinding: true }],
        ['an open blocks relation', { openBlocks: true }],
    ])('refuses a retirement proposal with %s', async (_label, options) => {
        const { root } = await fixture('kata-lifecycle-retire-blocked-', options);

        await expect(proposeRetirement(root, 'records-initiative', { sliceId: 'obsolete-slice' })).rejects.toThrow(/[Cc]annot retire/);
    });

    it('confirms an eligible proposal by hiding only the active projection while history stays readable', async () => {
        const { root } = await fixture('kata-lifecycle-retire-ok-');

        const proposal = await proposeRetirement(root, 'records-initiative', { sliceId: 'obsolete-slice' });
        const confirmed = await confirmRetirement(root, 'records-initiative', { proposalId: proposal.id, confirmedBy: 'operator' });

        expect(confirmed.retired).toContain('obsolete-slice');
        const state = await readInitiativeLifecycle(root, 'records-initiative');
        expect(state.history).toContainEqual(expect.objectContaining({ type: 'retirement_proposed' }));
        expect(state.history).toContainEqual(expect.objectContaining({ type: 'retirement_confirmed' }));
    });

    it('refuses a confirmation whose proposal is out of date', async () => {
        const { root, relationId } = await fixture('kata-lifecycle-retire-stale-');
        const proposal = await proposeRetirement(root, 'records-initiative', { sliceId: 'obsolete-slice' });

        // A packet arrives between the proposal and the confirmation: the slice is no longer eligible.
        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'impact_packet_recorded', relationId, packetId: 'packet-late',
        });

        await expect(confirmRetirement(root, 'records-initiative', { proposalId: proposal.id, confirmedBy: 'operator' }))
            .rejects.toThrow(/no longer eligible|changed/);

        // Nothing was retired: a refused confirmation leaves no retirement event behind.
        const state = await readInitiativeLifecycle(root, 'records-initiative');
        expect(state.current.retired).toEqual([]);
    });
});
