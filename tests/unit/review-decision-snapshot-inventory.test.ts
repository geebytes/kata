import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function bodyOf(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`Could not find ${start} .. ${end}`);
    return source.slice(from, to);
}

describe('review decision snapshot inventory', () => {
    it('permits raw current-revision reads only in the snapshot factory and commit validator', async () => {
        const [repairEntry, orchestrator, navigation] = await Promise.all([
            readFile(new URL('../../src/workflow/repair-entry.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../src/workflow/orchestrator.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../src/workflow/navigation.ts', import.meta.url), 'utf8'),
        ]);
        const repairAuthorization = bodyOf(repairEntry, 'export async function authorizeReviewRepair', 'export async function authorizeJudgeRepair');
        const reviewCommand = bodyOf(orchestrator, 'async function cmdReview', 'async function cmdJudge');

        expect(repairAuthorization).toContain('readReviewDecisionSnapshot(root, taskId)');
        expect(repairAuthorization).not.toMatch(/\breadCurrentTaskRevision(?:State)?\s*\(/);
        expect(reviewCommand).toContain('readReviewDecisionSnapshot(root, taskId)');
        expect(reviewCommand).not.toMatch(/\breadCurrentTaskRevision(?:State)?\s*\(/);
        expect(navigation).toContain('const snapshot = await readReviewDecisionSnapshot(root, taskId);');
        expect(navigation).not.toContain('const sealedRead = await readCurrentTaskRevisionState(root, taskId);');
    });
});
