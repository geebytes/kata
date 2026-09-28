import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    countFindingsBySeverity,
    isMergeBlocking,
    mergeBlockingProblems,
    mergeBlockingSeverities,
    reviewTierFor,
} from '../../src/workflow/review-read.js';
import { suggestCandidateAction, type UpstreamSummary } from '../../src/workflow/navigation.js';
import type { ReviewFinding } from '../../src/quality/reviewer.js';

/**
 * The severity ladder had three homes and no producer.
 *
 * "`blocking`, plus `major` in strict" was written out in `repair-entry.authorizeReviewRepair` (as
 * `severity === 'blocking'` plus an `isStrict` literal), in `navigation.suggestCandidateAction` (as two counts plus
 * `reviewMode === 'strict'`), and in `distill-gates.evaluateReviewClearance` (as a bare `severity === 'blocking'`, with
 * no mode at all). Three copies of one rule, already disagreeing: `distill-gates` did not look at the mode, so a `major`
 * finding refused clearance under neither std nor strict, and `security` — the tier whose kernel policy asks for two
 * reviewers, always-on quorum and a sandboxed assurance floor — was weaker than `strict` in all three places, because
 * every one of them compared against the string `'strict'`.
 *
 * Once the ladder is one exported answer, the three readers cannot drift again: the last test here reads the sources and
 * refuses a second comparison inside `src/workflow/`.
 */
describe('the severity ladder has one home', () => {
    it('names the severities each mode refuses approval for', () => {
        expect(mergeBlockingSeverities('std')).toEqual(['blocking']);
        expect(mergeBlockingSeverities('strict')).toEqual(['blocking', 'major']);
        // The correction this change exists for: security was weaker than strict in every copy of the rule.
        expect(mergeBlockingSeverities('security')).toEqual(['blocking', 'major']);
    });

    it('answers "does this severity block" from the same ladder', () => {
        expect(isMergeBlocking('strict', 'blocking')).toBe(true);
        expect(isMergeBlocking('strict', 'major')).toBe(true);
        expect(isMergeBlocking('strict', 'minor')).toBe(false);
        expect(isMergeBlocking('std', 'major')).toBe(false);
        expect(isMergeBlocking('security', 'major')).toBe(true);
        // A severity outside the vocabulary is not silently promoted to blocking: the ladder names what blocks.
        expect(isMergeBlocking('security', 'note')).toBe(false);
        expect(isMergeBlocking('security', undefined)).toBe(false);
    });

    it('is monotone: std is strictly weaker than strict, and strict never exceeds security', () => {
        const std = new Set(mergeBlockingSeverities('std'));
        const strict = new Set(mergeBlockingSeverities('strict'));
        const security = new Set(mergeBlockingSeverities('security'));
        for (const severity of std) expect(strict.has(severity)).toBe(true);
        for (const severity of strict) expect(security.has(severity)).toBe(true);
        expect([...strict].some((severity) => !std.has(severity))).toBe(true);
    });

    it('keeps the workflow vocabulary and the kernel tier vocabulary one mapping apart', () => {
        expect(reviewTierFor('std')).toBe('standard');
        expect(reviewTierFor('strict')).toBe('strict');
        expect(reviewTierFor('security')).toBe('security');
        // An absent profile is a legacy task, and legacy tasks were held to the std ladder; a mode nobody can name does
        // not silently become the strictest one, because that would newly refuse work no rule ever refused.
        expect(reviewTierFor(undefined)).toBe('standard');
    });

    it('names open problems from both sources that can carry one', () => {
        const findings: ReviewFinding[] = [
            { id: 'F-1', taskId: 't', severity: 'major', message: 'a legacy finding', path: 'src/a.ts' },
            { id: 'F-2', taskId: 't', severity: 'minor', message: 'a nit nobody blocks on' },
        ];
        const claims = [
            { id: 'C-9', severity: 'blocking', statement: 'the claim the ledger judges' },
            { id: 'C-10', severity: 'minor', statement: 'below the bar' },
        ];

        const strict = mergeBlockingProblems({ mode: 'strict', findings, claims });
        expect(strict.map((problem) => `${problem.source}:${problem.id}`)).toEqual(['finding:F-1', 'claim:C-9']);
        expect(strict[0]?.message).toBe('a legacy finding');

        const std = mergeBlockingProblems({ mode: 'std', findings, claims });
        expect(std.map((problem) => `${problem.source}:${problem.id}`)).toEqual(['claim:C-9']);
    });

    it('counts findings without re-deriving which of them block', () => {
        const findings: ReviewFinding[] = [
            { id: 'F-1', taskId: 't', severity: 'blocking', message: 'one' },
            { id: 'F-2', taskId: 't', severity: 'major', message: 'two' },
            { id: 'F-3', taskId: 't', severity: 'major', message: 'three' },
        ];
        expect(countFindingsBySeverity(findings)).toEqual({ blocking: 1, major: 2 });
    });

    it('routes a major finding back to build in every mode that blocks on it', () => {
        const upstream = (reviewMode: string): UpstreamSummary => ({
            reviewFindings: 1,
            blockingFindings: 0,
            majorFindings: 1,
            reviewMode,
            failedAcceptance: 0,
            failedVerifyAcceptance: 0,
            repairScopes: [],
            verifyRepairScopes: [],
            wikiClosureValid: true,
            evidenceFiles: [],
            failingEvidence: 0,
        });

        expect(suggestCandidateAction('review', upstream('strict'))?.reason).toBe('repair_strict_major_findings');
        // The correction: security blocked less than strict here, so this branch was unreachable in the stronger tier.
        expect(suggestCandidateAction('review', upstream('security'))?.reason).toBe('repair_strict_major_findings');
        expect(suggestCandidateAction('review', upstream('std'))?.reason).not.toBe('repair_strict_major_findings');
    });
});

/**
 * The second half of AC-1: the readers ask, they do not re-derive.
 *
 * A behavioural test can pass while a fourth copy of the rule sits in a branch nobody exercised. This one reads the
 * sources, so a new copy is a failing test rather than a review finding three rounds later.
 */
describe('no module under src/workflow re-derives the ladder', () => {
    const readers = ['repair-entry.ts', 'distill-gates.ts', 'navigation.ts', 'orchestrator.ts'];

    it('keeps every severity comparison inside review-read.ts', async () => {
        const offenders: string[] = [];
        for (const name of readers) {
            const path = join(process.cwd(), 'src/workflow', name);
            const source = await readFile(path, 'utf8');
            for (const [index, line] of source.split('\n').entries()) {
                // Comments are skipped on purpose: a comment that quotes the comparison it replaced cannot refuse an
                // approval, and refusing to explain a removal would push the explanation somewhere worse.
                const code = line.trim();
                if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
                if (/severity\s*(===|!==)\s*'(blocking|major)'/u.test(line)) {
                    offenders.push(`src/workflow/${name}:${index + 1}: ${line.trim()}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
