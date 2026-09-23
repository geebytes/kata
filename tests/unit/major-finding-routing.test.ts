import { reddenAllTasks } from '../helpers/reddening.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, type AcceptanceMatrix } from '../../src/core/task.js';
import { recordFinding } from '../../src/quality/reviewer.js';
import { resolveObligationsForRevision } from '../../src/quality/repair-obligations.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { writeCurrentState } from '../../src/core/state.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';

/**
 * The severity gate is "blocking, and major in strict" — one rule, stated in the design
 * (`2026-09-18-what-an-adversarial-pass-costs.md`), the navigation ladder and the approval guard.
 *
 * They disagreed. The ladder gated the major-to-repair branch on `reviewMode === 'strict'`; the approval guard refused a
 * major finding **unconditionally**. In std — the default — a task with one major finding could be neither approved nor
 * routed to the repair that would clear it, and the error it got named resolving the finding while the only action it was
 * offered was to re-review. This file pins both sides to the documented rule so they cannot drift apart again.
 */
describe('a major review finding follows the severity gate, in both the ladder and the approval guard', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    const matrix: AcceptanceMatrix = {
        version: 1,
        rows: [{
            acceptanceId: 'AC-1',
            implementationPaths: ['src/x.ts'],
            testPaths: ['tests/unit/major-finding-routing.test.ts'],
            evidence: [],
            verificationLevel: 'unit',
        }],
    };

    function passing(id: string): EvidenceEnvelope {
        return {
            id, taskId: 'x', kind: 'test', command: 'npm test', exitCode: 0,
            startedAt: '', finishedAt: '', diffHash: 'a'.repeat(64),
        };
    }

    async function taskWith(severity: 'blocking' | 'major' | 'minor', reviewMode?: 'strict' | 'std' | 'security'): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-routing-'));
        roots.push(root);
        await initLayout(root);
        const taskId = 'routing-task';
        await createTask({
            root, id: taskId, title: 'Routing',
            acceptance: [{ id: 'AC-1', statement: 'A major finding is repaired.' }],
            acceptanceMatrix: matrix,
            // `std` is the default the ladder must handle; `strict` is the case that already worked.
            ...(reviewMode ? { workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode, comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } } } : {}),
        });
        await recordFinding({ root, taskId, severity, message: `a ${severity} finding`, acceptanceId: 'AC-1' });
        // Clear the obligation the recording raised, so the earlier `repair_unresolved_obligations` branch does not
        // pre-empt the finding branch under test — the discharge of the obligation is a separate mechanism.
        await reddenAllTasks(root);
        await resolveObligationsForRevision(root, taskId, 'revision-1', ['AC-1'], ['e1'], undefined, [passing('e1')]);
        return root;
    }

    it('does not send a std major finding to repair, and does not refuse approval for it either', async () => {
        const root = await taskWith('major');
        const upstream = await readUpstreamSummary(root, 'routing-task');

        expect(upstream).toMatchObject({ majorFindings: 1, blockingFindings: 0 });
        // The ladder is unchanged: in std a major finding is reported, and the review concludes.
        expect(suggestCandidateAction('review', upstream).reason).not.toBe('repair_strict_major_findings');

        // And the approval guard must agree — refusing here left the task with no way forward at all.
        await writeCurrentState(root, { taskId: 'routing-task', phase: 'review', actor: { id: 'kata-agent', role: 'reviewer' }, updatedAt: new Date().toISOString() });
        const approval = await runCommand('review', 'routing-task', root, { approve: true, reviewEvidence: 'read the diff; one major finding accepted for std mode', confirmHostModel: true });
        expect(String(approval.error ?? '')).not.toContain('Cannot approve review with');
    });

    it('sends a strict major finding to repair', async () => {
        const root = await taskWith('major', 'strict');
        const action = suggestCandidateAction('review', await readUpstreamSummary(root, 'routing-task'));
        expect(action.nextSkill).toBe('/kata-build');
        expect(action.reason).toBe('repair_strict_major_findings');
    });

    it('still routes a blocking finding to repair', async () => {
        const root = await taskWith('blocking');
        const action = suggestCandidateAction('review', await readUpstreamSummary(root, 'routing-task'));
        expect(action.nextSkill).toBe('/kata-build');
        expect(action.reason).toBe('repair_blocking_review_findings');
    });

    it('leaves a minor finding to be concluded by the review', async () => {
        const root = await taskWith('minor');
        const action = suggestCandidateAction('review', await readUpstreamSummary(root, 'routing-task'));
        // A minor finding does not gate approval, so the review is the right next step — the fix must not swallow it.
        expect(action.nextSkill).toBe('/kata-review');
    });
});
