import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentRevisionPath, initLayout, repairPath } from '../../src/core/layout.js';
import { transitionForRepair } from '../../src/core/state.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { assertRepairBaselineStillCurrent } from '../../src/workflow/repair-entry.js';

async function seedTask(root: string, taskId: string, phase: 'review' | 'judge' | 'hardVerify'): Promise<void> {
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const v = "A";\n');
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
        id: taskId, title: 'T', phase, ownedPaths: ['subject.ts'],
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
    })}\n`);
    await writeFile(join(root, '.kata', 'tasks', taskId, 'current-state.json'), `${JSON.stringify({
        taskId, phase, actor: { id: 'a', role: 'implementer' }, updatedAt: '2026-10-05T00:00:00.000Z',
    })}\n`);
}

describe('repair records carry the revision they were decided on', () => {
    it('refuses to write a repair baseline that no longer describes the current revision', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-repair-baseline-'));
        const taskId = 'repair-baseline-stale';
        await initLayout(root);
        await seedTask(root, taskId, 'review');
        const a = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

        // B lands between the decision (which named A) and the repair write.
        await writeFile(join(root, 'subject.ts'), 'export const v = "B";\n');
        const b = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        expect(b.revision.id).not.toBe(a.revision.id);

        await expect(transitionForRepair({
            taskId,
            actor: { id: 'a', role: 'implementer' },
            entryPhase: 'review',
            repair: { fromPhase: 'review', reason: 'revision_superseded', baselineRevisionId: a.revision.id, baselineManifestHash: a.revision.manifestHash },
            root,
            verifyStillCurrent: () => assertRepairBaselineStillCurrent(root, taskId, a.revision.id),
        })).rejects.toThrow(/baseline|superseded|moved/i);

        // Nothing was written: the record still describes no baseline rather than the wrong one.
        await expect(readFile(repairPath(root, taskId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const pointer = JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')) as { id: string };
        expect(pointer.id).toBe(b.revision.id);
    });

    it('records the repair when its baseline still describes the current revision', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-repair-baseline-ok-'));
        const taskId = 'repair-baseline-current';
        await initLayout(root);
        await seedTask(root, taskId, 'review');
        const a = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

        await transitionForRepair({
            taskId,
            actor: { id: 'a', role: 'implementer' },
            entryPhase: 'review',
            repair: { fromPhase: 'review', reason: 'revision_superseded', baselineRevisionId: a.revision.id, baselineManifestHash: a.revision.manifestHash },
            root,
        });

        const repair = JSON.parse(await readFile(repairPath(root, taskId), 'utf8')) as { baselineRevisionId?: string; toPhase?: string };
        expect(repair.baselineRevisionId).toBe(a.revision.id);
        expect(repair.toPhase).toBe('implement');
    });

    it('is passed by the production repair entry, not only available to callers', async () => {
        const orchestrator = await readFile(new URL('../../src/workflow/orchestrator.ts', import.meta.url), 'utf8');
        const from = orchestrator.indexOf('async function reenterImplementForRepairEntry');
        const to = orchestrator.indexOf('async function', from + 10);
        const body = orchestrator.slice(from, to);
        // The check exists for the production path; a caller that forgets to pass it gets the old behaviour silently, so
        // the consumer is asserted here rather than only the helper that implements it.
        expect(body).toContain('verifyStillCurrent: () => assertRepairBaselineStillCurrent(root, taskId, decidedOn)');
    });
});
