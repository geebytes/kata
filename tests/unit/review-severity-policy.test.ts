import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    countFindingsBySeverity,
    isMergeBlocking,
    mergeBlockingProblems,
    mergeBlockingSeverities,
    reviewTierFor,
} from '../../src/quality/review-ladder.js';
import { suggestCandidateAction, type UpstreamSummary } from '../../src/workflow/navigation.js';
import type { ReviewFinding } from '../../src/quality/reviewer.js';

/**
 * The spellings a second copy of the ladder can take. Deliberately broad: a narrowing pattern is a guard that lets the
 * next copy through, and the check below proves each alternative still matches something it is meant to.
 */
const SEVERITY_OR_TIER_LITERAL = /(severity|severities|blockingSeverities)\s*(===|!==|\.includes\()\s*'(blocking|major)'|case\s+'(blocking|major)'\s*:|(reviewMode|reviewTier)\s*===\s*'(strict|security|std|standard)'/u;

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
 *
 * **It scans both `src/workflow/` and `src/quality/`, and it knows more than one spelling.** The first version scanned
 * four named files for `severity === 'blocking'` and an independent review walked straight past it: a copy written as
 * `case 'blocking':`, or `severities.includes('major')`, or a mode compared with `=== 'strict'` to gate a tier decision,
 * would have passed. The files are enumerated rather than listed, so a new module is covered the day it is added.
 */
describe('no module outside the ladder re-derives it', () => {
    /** The one module allowed to compare a severity or a tier: it is where the rule lives. */
    const ladderModule = 'src/quality/review-ladder.ts';
    /**
     * Files that may still compare a *tier* with a literal, each with the reason it is not the ladder.
     *
     * A guard with an exception list is only honest if the exceptions are named, reasoned and few. There is one, its reason
     * is the same sentence that appears beside the rule in the source, and it is a decision to fix elsewhere rather than a
     * thing the check forgot about.
     */
    const knownDeviations = new Map([
        ['src/quality/acceptance-matrix.ts', 'requiresMatrix asks whether a *route* carries an acceptance contract and names the tier instead; every tier at or above strict was measured to break the tweak lifecycle, so the asymmetry is recorded in that function and is a separate change'],
    ]);

    it('keeps every severity and tier comparison inside the ladder module', async () => {
        const offenders: string[] = [];
        for (const directory of ['src/workflow', 'src/quality']) {
            for (const entry of await readdir(join(process.cwd(), directory))) {
                if (!entry.endsWith('.ts')) continue;
                const relative = `${directory}/${entry}`;
                if (relative === ladderModule) continue;
                if (knownDeviations.has(relative)) continue;
                const source = await readFile(join(process.cwd(), relative), 'utf8');
                for (const [index, line] of source.split('\n').entries()) {
                    // Comments are skipped on purpose: a comment that quotes the comparison it replaced cannot refuse an
                    // approval, and refusing to explain a removal would push the explanation somewhere worse.
                    const code = line.trim();
                    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
                    if (SEVERITY_OR_TIER_LITERAL.test(line)) {
                        offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('names a reason for every file it lets past, and keeps the list short', () => {
        for (const [path, reason] of knownDeviations) {
            expect(reason.trim().length, path).toBeGreaterThan(40);
        }
        expect(knownDeviations.size).toBeLessThanOrEqual(1);
    });

    it('finds the patterns it claims to, so the guard is not one that cannot fail', () => {
        // A guard whose pattern matches nothing passes for the wrong reason, and this repository has removed more of
        // those than any other class. Each spelling below is one an independent review actually used to walk past the
        // previous version of this check.
        for (const line of [
            "const blocking = findings.filter((finding) => finding.severity === 'blocking');",
            "if (severity !== 'major') continue;",
            "switch (finding.severity) { case 'blocking': return true; }",
            "if (blockingSeverities.includes('major')) return true;",
            "if (task.workflowProfile?.reviewMode === 'strict' && upstream.majorFindings > 0) {",
            "const isStrict = task?.workflowProfile?.reviewMode === 'strict';",
        ]) {
            expect(SEVERITY_OR_TIER_LITERAL.test(line), line).toBe(true);
        }
        // And it does not fire on the ladder module's own implementation lines being discussed in prose.
        expect(SEVERITY_OR_TIER_LITERAL.test("    if (named === 'strict') return 'strict';")).toBe(false);
    });
});
