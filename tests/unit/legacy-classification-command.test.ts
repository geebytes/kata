import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTaskClassification } from '../../src/core/task.js';
import { runTaskClassificationCommand } from '../../src/cli/workflow.js';

describe('legacy task classification', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    it('derives and records a missing classification from the existing declaration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-legacy-classification-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, 'src', 'kernel'), { recursive: true });
        await writeFile(join(root, 'src', 'kernel', 'risk.ts'), 'export const risk = true;\n');
        await createTask({
            root,
            id: 'legacy-classification',
            title: 'Legacy classification fixture',
            acceptance: [{ id: 'AC-1', statement: 'classification is recorded after open' }],
            ownedPaths: ['src/kernel/risk.ts'],
            workflowProfile: {
                version: 1,
                isolationMode: 'current_worktree',
                developmentMode: 'tdd',
                reviewMode: 'strict',
                comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
            },
        });

        const result = await runTaskClassificationCommand('legacy-classification', root, []);

        expect(result.classification).toMatchObject({ taskId: 'legacy-classification', facts: { declaredPaths: ['src/kernel/risk.ts'] } });
        expect(await readTaskClassification(root, 'legacy-classification')).toMatchObject({ kind: 'usable' });
        await expect(runTaskClassificationCommand('legacy-classification', root, [])).rejects.toThrow('already has a classification');
    });
});
