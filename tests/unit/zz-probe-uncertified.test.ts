import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentRevisionPath, initLayout, reviewPath, revisionsDir } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { evaluateDistillGates } from '../../src/workflow/distill-gates.js';
import { computeDiffHash } from '../../src/quality/evidence.js';
import { writeCurrentState } from '../../src/core/state.js';

const taskId = 'probe-uncertified';

describe('probe: is an uncertified current revision refused elsewhere', () => {
    it('measures the gates after a refused seal advanced the pointer', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-uncertified-'));
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/owned.ts'), 'export const holds = true;\n', 'utf8');
        await runCommand('open', taskId, root, { title: 'probe', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/owned.ts'] });
        await runCommand('design', taskId, root);
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/owned.ts'], checkIds: [] });
        const record = await buildChangeRecord({ root, taskId, revisionId: sealed.revision.id, ownedPaths: ['src/owned.ts'], evidence: [], claimFailures: [], findings: [] });
        const written = await writeChangeRecord(root, taskId, record);
        if (typeof written !== 'string') throw new Error(written.refused.join('; '));
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify({ at: '2026-01-01T00:00:00.000Z', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] }),
            JSON.stringify({ at: '2026-01-02T00:00:00.000Z', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, blockingIds: ['F-2'], blockingCount: 1, findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] }),
        ].join('\n') + '\n');
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, reviewedRevisionId: sealed.revision.id,
            recordedAt: '2026-01-03T00:00:00.000Z', reviewKind: 'root_cause',
            recurrenceAnalysis: { triggerClasses: ['instrument-unsound'], conclusion: 'instrument_unsound', evidence: ['x'], nextAction: 'repair',
                closureObligation: { states: ['a', 'b'], sourceOfTruth: 'theOne', inventory: ['src/owned.ts:1'], invariant: 'i', repairSurface: ['src/owned.ts'], effectivenessTest: 'a sentence naming no check at all', ifRecursAgain: 'rewrite_mechanism' } },
            findings: [], status: 'pending',
        })}\n`);

        // The certified state: a clean seal with all three gates, so the probe measures the *change* the refused seal makes.
        const certified = JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')).id as string;
        const diffHash = await computeDiffHash(root);
        await mkdir(join(root, '.kata/evidence'), { recursive: true });
        await writeFile(join(root, '.kata/evidence/e1.json'), `${JSON.stringify({
            id: 'evidence-1', taskId, kind: 'test', command: 'npm test', exitCode: 0,
            startedAt: '2026-01-04T00:00:00.000Z', finishedAt: '2026-01-04T00:00:01.000Z', diffHash, revisionId: certified,
        })}\n`);
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: certified, manifestHash: sealed.revision.manifestHash, reviewedRevisionId: certified,
            reviewEvidence: 'the independent round', findings: [], status: 'approved',
        })}\n`);
        await writeFile(join(root, '.kata/tasks', taskId, 'judge.json'), `${JSON.stringify({
            taskId, result: 'PASS', diffHash, revisionId: certified, manifestHash: sealed.revision.manifestHash,
            acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: ['evidence-1'] }], evidenceIds: ['evidence-1'],
        })}\n`);

        const before = await evaluateDistillGates(root, taskId);
        console.log('PROBE before: evidence', Boolean(before.freshEvidence), 'review', JSON.stringify(before.review.cleared), 'judge', JSON.stringify(before.judge));

        // Now change the content and seal: the closure contract cannot be satisfied, so the seal is refused.
        await writeFile(join(root, 'src/owned.ts'), 'export const holds = "changed";\n', 'utf8');
        const refused = await runCommand('build', taskId, root, { seal: true, checks: [] });
        const now = JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')).id as string;
        console.log('PROBE refused seal success=' + refused.success, 'reason=' + String(refused.diagnostics?.reason));
        console.log('PROBE pointer advanced:', certified !== now, '(certified', certified, '-> now', now + ')');
        console.log('PROBE revisions on disk:', (await import('node:fs/promises')).readdir(revisionsDir(root, taskId)).then((x) => x.length).catch(() => 'ERR'));

        const after = await evaluateDistillGates(root, taskId);
        console.log('PROBE after: evidence', JSON.stringify(after.freshEvidence?.evidence.id ?? null), 'review', JSON.stringify(after.review), 'judge', JSON.stringify(after.judge));
        const assertions = await (await import('../../src/workflow/distill-gates.js')).assertDistillGates(root, taskId).then(() => 'NO REFUSAL', (e: Error) => e.message);
        console.log('PROBE assertDistillGates:', assertions.slice(0, 220));
        // And archive, which is the entry that matters: does it let an uncertified revision through?
        await writeCurrentState(root, { taskId, phase: 'archive', actor: { id: 'kata-cli', role: 'distiller' }, updatedAt: '2026-01-05T00:00:00.000Z' });
        const archive = await runCommand('archive', taskId, root, {}).then((r) => `success=${r.success} ${String(r.error ?? '').slice(0, 160)}`, (e: Error) => `THREW ${e.message.slice(0, 120)}`);
        console.log('PROBE archive:', archive);
        await rm(root, { recursive: true, force: true });
        expect(true).toBe(true);
    });
});
