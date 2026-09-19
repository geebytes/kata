import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { openBatch, readBatches } from '../../src/quality/repair-batch.js';

/**
 * C1's end-to-end chain, which is what was missing: **the mechanism had no producer.**
 *
 * `openRepairBatch` and `closeRepairBatch` were called from tests only, so no batch was ever opened, so `defaultBriefScope`
 * always found none and C4's delta default always fell back to full with the reason *"no repair batch has closed"*. A
 * mechanism reachable and inert — the shape this repository keeps meeting.
 */
describe('a repair batch opens, closes, and makes the next round narrow', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-batch-e2e-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'chain', title: 'Chain', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.py'), 'x = 1\n', 'utf8');
        await writeFile(
            join(root, '.kata-config.json'),
            JSON.stringify({ quality: { discoverChecks: false, buildChecks: [{ id: 'noop', name: 'noop', kind: 'lint', command: 'true' }] } }),
            'utf8',
        );
        // Verify first checks the Wiki closure, which is governance rather than the subject here.
        const { writeWikiClosure } = await import('../../src/wiki/closure.js');
        await writeWikiClosure(root, 'chain', { decision: 'not_applicable', reason: 'fixture: no knowledge to capture' });
        await runCommand('design', 'chain', root, {});
        return root;
    }

    it('a blocking finding opens a batch with the base revision stamped at open', async () => {
        const root = await workspace();
        const { issueAdversarialBrief } = await import('../../src/quality/adversarial.js');
        // Seal first: verify consults the adversarial gate only once the implementation is ready, so a fixture with no
        // evidence never reaches the producer. This is the path a real task takes.
        const seal = await runCommand('build', 'chain', root, { seal: true });
        expect(seal.success).toBe(true);
        const sealed = JSON.parse(await readFile(join(root, '.kata/tasks/chain/current-revision.json'), 'utf8')) as { id: string; manifestHash: string };
        const brief = await issueAdversarialBrief(root, 'chain', 'verify');
        const resultFile = join(root, 'result.json');
        await writeFile(resultFile, JSON.stringify({
            node: 'verify',
            status: 'recorded',
            revisionId: sealed.id,
            executedInFreshContext: true,
            contextNote: 'Fixture recorded a pass with a blocking finding.',
            createdAt: '2026-09-19T00:00:00.000Z',
            briefSha256: brief.sha256,
            verdict: 'defects_found',
            attempts: [{ hypothesis: 'h', method: 'm', outcome: 'confirmed' }],
            findings: [{ id: 'b1', taskId: 'chain', severity: 'blocking', message: 'must be repaired' }],
        }), 'utf8');

        // Recording the pass is where its findings become known — the command that opens the batch.
        const { runAdversarialCommand } = await import('../../src/cli/ops.js');
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            await runAdversarialCommand(['record', '--change', 'chain', '--node', 'verify', '--from-file', resultFile]);
        } finally {
            process.chdir(previousCwd);
        }

        const batches = await readBatches(root, 'chain');
        expect(batches).toHaveLength(1);
        // The base is the revision the repair starts from, stamped at open — not something a caller supplies later.
        expect(batches[0]!.baseRevisionId).toBe(sealed.id);
        expect(batches[0]!.findings.map((finding) => finding.id)).toEqual(['b1']);
        expect(await openBatch(root, 'chain')).not.toBeNull();
    });

    it('a successful seal closes the batch, and the next brief narrows against the base', async () => {
        const root = await workspace();
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const base = await createTaskRevision({ root, taskId: 'chain', ownedPaths: ['src/a.py'], checkIds: [] });

        const { openRepairBatch } = await import('../../src/quality/repair-batch.js');
        await openRepairBatch(root, 'chain', [{ id: 'b1', severity: 'blocking', source: 'adversarial-verify', message: 'repaired now' }]);

        // The repair changes the code, then the seal runs over it.
        await writeFile(join(root, 'src/a.py'), 'x = 2\n', 'utf8');
        const sealed = await runCommand('build', 'chain', root, { seal: true });
        expect(sealed.success).toBe(true);

        // The seal ended the batch — that is C1's contract, one seal per batch.
        expect(await openBatch(root, 'chain')).toBeNull();
        const closed = (await readBatches(root, 'chain'))[0]!;
        expect(closed.closedAt).toBeTruthy();
        // And its base is still the revision the repair started from, so the next round has something to narrow against.
        expect(closed.baseRevisionId).toBe(base.id);

        const { buildAdversarialBrief } = await import('../../src/quality/adversarial.js');
        const brief = await buildAdversarialBrief(root, 'chain', 'verify');
        expect(brief.delta).toMatchObject({ from: base.id, changedPaths: ['src/a.py'] });
        expect(brief.scopeReason).toMatch(/batch batch-1 started from/);
        expect(brief.scopeReason).not.toMatch(/no repair batch has closed/);
    });

    it('the base is never the revision that was just sealed, which would narrow to nothing', async () => {
        const root = await workspace();
        const { createTaskRevision } = await import('../../src/workflow/revision.js');
        const { openRepairBatch } = await import('../../src/quality/repair-batch.js');

        const before = await createTaskRevision({ root, taskId: 'chain', ownedPaths: ['src/a.py'], checkIds: [] });
        await openRepairBatch(root, 'chain', [{ id: 'b1', severity: 'major', source: 'review', message: 'x' }]);
        await writeFile(join(root, 'src/a.py'), 'x = 3\n', 'utf8');
        await runCommand('build', 'chain', root, { seal: true });

        const closed = (await readBatches(root, 'chain'))[0]!;
        const after = JSON.parse(await readFile(join(root, '.kata/tasks/chain/current-revision.json'), 'utf8')) as { id: string };
        // If the base were the new revision, the delta would be empty forever — the mistake the field's name now prevents.
        expect(closed.baseRevisionId).toBe(before.id);
        expect(closed.baseRevisionId).not.toBe(after.id);
    });
});

describe('the batch the platform acts on is visible', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('adversarial status reports the open batch and what batching saved', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-batch-status-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'vis', title: 'Vis', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const { openRepairBatch, closeRepairBatch } = await import('../../src/quality/repair-batch.js');
        const { runAdversarialCommand } = await import('../../src/cli/ops.js');

        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            await openRepairBatch(root, 'vis', [
                { id: 'f-1', severity: 'major', source: 'review', message: 'a' },
                { id: 'f-2', severity: 'major', source: 'review', message: 'b' },
            ]);
            const open = await runAdversarialCommand(['status', '--change', 'vis']);
            expect(open.repairBatch).toMatchObject({ open: { id: 'batch-1', findings: ['f-1', 'f-2'] }, batches: 1, closed: 0 });

            await closeRepairBatch(root, 'vis', { answered: ['f-1', 'f-2'] });
            const closed = await runAdversarialCommand(['status', '--change', 'vis']);
            // Two findings in one batch means one seal where a per-finding repair would have sealed twice.
            expect(closed.repairBatch).toMatchObject({ open: null, batches: 1, closed: 1, findingsBatched: 2, sealsAvoided: 1 });
        } finally {
            process.chdir(previousCwd);
        }
    });
});
