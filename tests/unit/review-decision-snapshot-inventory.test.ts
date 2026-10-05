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

    it('takes the pointer read in hand in every review-family reader', async () => {
        const [reviewRead, distillGates, reviewIr, reviewRequest] = await Promise.all([
            readFile(new URL('../../src/workflow/review-read.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../src/workflow/distill-gates.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../src/quality/review-ir.ts', import.meta.url), 'utf8'),
            readFile(new URL('../../src/store/review-request.ts', import.meta.url), 'utf8'),
        ]);
        // `sealedRead` is the caller's read handed over so the pointer is not asked twice. It is optional in type and
        // required in spirit, so the obligation is asserted at the call sites that decide a review outcome rather than
        // left to each author: the distill gate decides clearance from it and the record reader decides binding from it.
        expect(distillGates).not.toMatch(/await readCurrentTaskRevision(?:State)?\s*\(/);
        expect(distillGates).toMatch(/readReviewRecord\(root, taskId, snapshot\.revisionRead\)/);
        expect(distillGates).toMatch(/readBlockingProblems\(root, taskId, snapshot\.revisionRead\)/);
        // Both keep an optional fallback for a caller with no read in hand, and both say so at the line. What may not
        // exist is a read taken *instead of* the caller's — i.e. one that shadows a read that was handed in.
        expect(reviewIr).toMatch(/revisionRead \?\? await readCurrentTaskRevision\(root, taskId\)|if \(revisionRead\)/);
        expect(reviewRequest).toMatch(/sealedRead \?\? await readCurrentTaskRevisionState\(input\.root, input\.changeId\)/);
        // The reader still accepts a caller without a read — it must, or the three-state refusal loses its fallback —
        // but it may only reach for the pointer once the caller has not supplied one, never for its own convenience.
        expect(reviewRead).toMatch(/sealedRead \?\? await readCurrentTaskRevisionState\(root, taskId\)/);
    });

    it('keeps every binding field the record carries, including the frozen candidate', async () => {
        const reviewRead = await readFile(new URL('../../src/workflow/review-read.ts', import.meta.url), 'utf8');
        const binding = bodyOf(reviewRead, 'const binding: VerdictBinding = {', 'const bound = bindsToRevision(');
        // `bindsToRevision` gives the frozen candidate precedence over the owned manifest, so a reader that drops
        // `candidateFreezeSha256` reports a correctly freeze-bound record as unbound whenever the manifest moved — and
        // every consumer of the one reader then drops the record's findings, in the fail-open direction.
        for (const field of ['revisionId', 'manifestHash', 'candidateFreezeSha256', 'codeManifestHash', 'governanceManifestHash', 'instrumentManifestHash']) {
            expect(binding, `the binding must carry ${field}`).toContain(field);
        }
    });

    it('asks one reader for the approval decision instead of two with different fields', async () => {
        const orchestrator = await readFile(new URL('../../src/workflow/orchestrator.ts', import.meta.url), 'utf8');
        const command = bodyOf(orchestrator, 'async function cmdReview', 'async function cmdJudge');
        // `readReview` returns no `manifestHash`, so a binding built from it can never satisfy the manifest branch of
        // `bindsToRevision` — the approval's refusal text promises "(or the same content)" and that branch was
        // unreachable. The record is read once now, through the reader that carries every binding field.
        const approval = command.slice(command.indexOf('if (options.approve)'));
        expect(approval).not.toMatch(/await readReview\(root, taskId\)/);
        // The decision itself must be assembled from that reader's record, with every field it can carry — a binding
        // built from anything narrower is the defect this asserts against, in whatever spelling it is written.
        expect(approval).toMatch(/const approvalRecord = await readReviewRecord\(root, taskId, approvalRevisionRead\);/);
        expect(approval).toMatch(/candidateFreezeSha256: approvalRecord\.record\.candidateFreezeSha256/);
        expect(approval).toMatch(/findings: approvalRecord\.findings, status: 'approved'/);
        // The binding is assembled from that reader's record, and the stamped findings come from the same record —
        // the two used to be answered from two different reads of the same file.
        expect(approval).toMatch(/const existing: VerdictBinding = \{\s*\.\.\.\(typeof approvalRecord\.record\.revisionId/);
    });

});
