import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-loop-entrypoint-'));
    roots.push(root);
    await initLayout(root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Review-loop verdict unification entrypoint', () => {
    it('does not escalate a new review from only foreign and legacy rounds', async () => {
        const root = await tempRoot();
        const taskId = 'review-loop-foreign-rounds';

        await runCommand('open', taskId, root, {
            acceptance: [{ id: 'AC-1', statement: 'Foreign review rounds are audit-only.' }],
        });
        await runCommand('design', taskId, root);
        await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
        await runCommand('build', taskId, root, {
            ownedPaths: ['task-owned.txt'],
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        });
        await writeFile(reviewRoundsPath(root, taskId), [1, 2, 3, 4].map((at) => JSON.stringify({
            at: String(at),
            revisionId: 'revision-foreign',
            manifestHash: 'f'.repeat(64),
            blockingCount: 3,
            blockingIds: ['F-foreign'],
        })).concat(JSON.stringify({ at: 'legacy', blockingCount: 3, blockingIds: ['F-legacy'] })).join('\n') + '\n', 'utf8');

        const result = await runCommand('review', taskId, root, { confirmHostModel: true });

        expect(result).toMatchObject({ success: true, phase: 'review' });
        const summary = await readUpstreamSummary(root, taskId);
        const route = suggestCandidateAction('review', summary);
        expect(route).toMatchObject({
            reason: 'complete_review_conclusion',
            nextSkill: '/kata-review',
        });
    });
});
