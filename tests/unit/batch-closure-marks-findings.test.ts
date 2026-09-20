import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { addAdversarialFinding, resolveBriefMode, writeAdversarialRecord } from '../../src/quality/adversarial.js';
import { closeBatchAfterSeal, openRepairBatch } from '../../src/quality/repair-batch.js';
import { readTrackedFindings } from '../../src/quality/finding-disposition.js';
import { persistBlockingFindings, resolveObligationsForRevision } from '../../src/quality/repair-obligations.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';

/**
 * Closing a repair batch is what says its findings were repaired, so the closure has to make that visible.
 *
 * `closeRepairBatch` computed `answered` from the obligations that carry a `resolvedAt` — but a finding's *disposition*
 * is a separate field that only a disposition record writes, so a batch could close with `answered: [id]` while
 * `readTrackedFindings` still reported that finding `open`. The round framing reads the disposition, so the next brief
 * went on saying "an open major finding is unrepaired, so this round checks the repair" — after the repair, against the
 * closed batch that recorded it.
 */
describe('a closed batch marks its answered findings', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const findingId = 'artifact-appends-across-seals';

    function passing(id: string): EvidenceEnvelope {
        return {
            id, taskId: 'x', kind: 'test', command: 'npm test', exitCode: 0,
            startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:00:01.000Z', diffHash: 'a'.repeat(64),
        };
    }

    async function threadOpenedBatch(root: string, taskId: string): Promise<void> {
        await initLayout(root);
        await createTask({ root, id: taskId, title: 'Closure', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await writeAdversarialRecord(root, taskId, {
            node: 'review', status: 'recorded', revisionId: 'revision-1', createdAt: '2026-09-20T00:00:00.000Z',
            executedInFreshContext: true, contextNote: 'fixture', attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }], findings: [],
        });
        await addAdversarialFinding(root, taskId, 'review', { id: findingId, severity: 'major', message: 'a major finding' });
        // The batch the review node opens for a terminal finding, and the obligation that lets it be closed.
        await openRepairBatch(root, taskId, [{ id: findingId, severity: 'major', message: 'a major finding', source: 'adversarial-review' }]);
        await persistBlockingFindings(root, taskId, [{ id: findingId, severity: 'major', message: 'a major finding' }]);
    }

    it('marks an answered finding fixed, and stops the brief calling it unrepaired', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-batch-marks-'));
        roots.push(root);
        const taskId = 'closure-task';
        await threadOpenedBatch(root, taskId);

        // Before: the finding is open, so the framing says the repair has not happened.
        expect((await readTrackedFindings(root, taskId)).find((finding) => finding.id === findingId)?.disposition).toBe('open');
        expect((await resolveBriefMode(root, taskId, 'review')).mode).toBe('verify');

        // The seal resolves the obligation from its evidence, then closes the batch.
        await resolveObligationsForRevision(root, taskId, 'revision-1', ['AC-1'], ['evidence-1'], undefined, [passing('evidence-1')]);
        const closed = await closeBatchAfterSeal(root, taskId);

        expect(closed).toMatchObject({ answered: [findingId] });
        // After: the finding is fixed, and the round stops being framed as checking an unrepaired repair.
        expect((await readTrackedFindings(root, taskId)).find((finding) => finding.id === findingId)?.disposition).toBe('fixed');
        expect((await resolveBriefMode(root, taskId, 'review')).reason).not.toContain('is unrepaired');
    });
});
