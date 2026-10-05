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
        // Every current-revision read in these two files goes through the snapshot factory: the criterion says direct reads
        // exist only in the factory and the commit validator, so the non-review reads (seal base, narrowing base, verify,
        // judge) route through the factory too rather than being excused by a narrower reading of the sentence.
        expect(orchestrator).not.toMatch(/await readCurrentTaskRevision(?:State)?\s*\(/);
        expect(repairEntry).not.toMatch(/await readCurrentTaskRevision(?:State)?\s*\(/);
    });
    it('binds every repair authorizer to one snapshot instead of reading the pointer itself', async () => {
        const repairEntry = await readFile(new URL('../../src/workflow/repair-entry.ts', import.meta.url), 'utf8');
        // The review branch was the first to be fixed; its two siblings kept reading the pointer for themselves, and the
        // judge branch wrote that unvalidated read into the repair baseline. Every authorizer takes one snapshot and
        // derives the revision it judges from it.
        for (const [start, end] of [
            ['export async function authorizeVerifyRepair', 'export async function authorizeReviewRepair'],
            ['export async function authorizeReviewRepair', 'export async function authorizeJudgeRepair'],
            ['export async function authorizeJudgeRepair', 'const authorizers:'],
        ] as const) {
            const body = bodyOf(repairEntry, start, end);
            expect(body, `${start} must take a decision snapshot`).toContain('readReviewDecisionSnapshot(root, taskId)');
            expect(body, `${start} must not read the current pointer directly`).not.toMatch(/\breadCurrentTaskRevision(?:State)?\s*\(/);
        }
    });
});
