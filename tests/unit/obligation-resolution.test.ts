import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { persistBlockingFindings, readObligations, resolveObligationsForRevision } from '../../src/quality/repair-obligations.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';

/**
 * Resolving an obligation is a question about evidence, and a matrix is one way to answer it — not the only one.
 *
 * `resolveObligationsForRevision` was called only when the task had an `acceptanceMatrix`, so a task opened without one
 * — the `/kata-open` default — could never resolve an obligation: its repair batch stayed open however well the repair
 * went. Two shapes have to keep working: an obligation scoped to a criterion, and one scoped to nothing (an adversarial
 * finding is not tied to an AC the way a review finding is).
 */
describe('resolving a repair obligation', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function fixture(id: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-resolve-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id, title: 'Resolution', acceptance: [{ id: 'AC-1', statement: 'A repair is accounted for.' }] });
        return root;
    }

    function passing(id: string): EvidenceEnvelope {
        return {
            id, taskId: 'x', kind: 'test', command: 'npm test', exitCode: 0,
            startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:00:01.000Z', diffHash: 'a'.repeat(64),
        };
    }

    // The matrix path is asserted in tests/e2e/quality-gates.test.ts ("repair obligations persist across revisions"),
    // which is why these cases are all matrix-less: that is the shape this change made resolvable.
    it('resolves an obligation with no acceptance id on a matrix-less task', async () => {
        const root = await fixture('unscoped-task');
        // An adversarial finding is not scoped to a criterion, so its obligation carries no `acceptanceId`. Requiring an
        // AC to resolve left every such obligation permanently open, and the seal correctly refused on it forever.
        await persistBlockingFindings(root, 'unscoped-task', [{ id: 'finding-1', severity: 'major', message: 'a major finding' }]);

        await resolveObligationsForRevision(root, 'unscoped-task', 'revision-1', ['AC-1'], ['evidence-1'], undefined, [passing('evidence-1')]);

        const [obligation] = await readObligations(root, 'unscoped-task');
        expect(obligation!.resolvedAt).toBeDefined();
        expect(obligation!.resolvedByRevisionId).toBe('revision-1');
        expect(obligation!.resolvedEvidenceIds).toEqual(['evidence-1']);
    });

    it('leaves an unscoped obligation open when the revision has no passing evidence', async () => {
        const root = await fixture('empty-task');
        await persistBlockingFindings(root, 'empty-task', [{ id: 'finding-1', severity: 'blocking', message: 'a blocking finding' }]);

        await resolveObligationsForRevision(root, 'empty-task', 'revision-1', ['AC-1'], [], undefined, []);

        // A revision that proved nothing answers nothing: the refusal is the point, not an edge case.
        const [obligation] = await readObligations(root, 'empty-task');
        expect(obligation!.resolvedAt).toBeUndefined();
    });

    it('still waits for the criterion when the obligation names one and no matrix binds it to a check', async () => {
        const root = await fixture('scoped-task');
        await persistBlockingFindings(root, 'scoped-task', [{ id: 'finding-1', severity: 'blocking', acceptanceId: 'AC-2', message: 'a blocking finding' }]);

        await resolveObligationsForRevision(root, 'scoped-task', 'revision-1', ['AC-1'], ['evidence-1'], undefined, [passing('evidence-1')]);

        // AC-2 is not satisfied, so the obligation it raised is not answered — the criterion still gates it.
        const [obligation] = await readObligations(root, 'scoped-task');
        expect(obligation!.resolvedAt).toBeUndefined();
    });
});
