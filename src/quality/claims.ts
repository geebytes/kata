import { hashContent } from '../core/hash.js';
import type { AcceptanceCriterion, ClaimDeclaration } from '../core/task.js';
import type { CheckCommand } from './evidence.js';

/**
 * Machine-checkable acceptance statements (C3 of the pass-cost proposal) — the largest of the five changes.
 *
 * Measured, twice in one day: **a false sentence in the acceptance text passed the seal *and* verify**, and was caught only
 * by the next adversarial round. Prose has no test. A claim gives the sentence a command, so a false claim fails the gate
 * instead of waiting to be noticed.
 *
 * What this deliberately is not: claims are **additional** evidence. They never replace a row's own checks, and they never
 * replace the independent adversarial pass — a claim proves a sentence about the code, and the pass is what finds the
 * sentence nobody thought to write. The proposal's C3 invariant is the reason the declaration carries its command *with*
 * the statement: editing the sentence is editing the thing the check is attached to, so a statement cannot change without
 * its check re-running.
 */

/** Why a claim declaration was refused — a check that cannot fail is not evidence. */
export interface ClaimRefusal {
    acceptanceId: string;
    claimId: string;
    reason: 'no_expected_outcome' | 'empty_command' | 'duplicate_id';
    detail: string;
}

export interface ClaimCheckSummary {
    acceptanceId: string;
    claimId: string;
    statement: string;
    /** The id the resolved check carries, so its evidence is matched structurally rather than by command text. */
    checkId: string;
    /** The outcome the claim declares, so "it passed" means "it did what the sentence says". */
    expect: { exitCode: number };
}

/** A claim that a run contradicted: blocking-class, with the sentence and the command that disagrees with it. */
export interface ClaimFailure extends ClaimCheckSummary {
    actualExitCode: number | null;
    /** True when the check produced no evidence at all, which is a failure of the claim rather than a pass. */
    missing: boolean;
}

/**
 * Whether a claim can be checked at all.
 *
 * The rule, from the proposal: **every claim check must be demonstrated able to fail**. A check with no expected outcome
 * cannot fail, so it cannot be evidence; that is refused here rather than left to a reviewer to notice, because a
 * decorative check is exactly what a false sentence hides behind.
 */
export function validateClaims(acceptance: AcceptanceCriterion[]): ClaimRefusal[] {
    const refusals: ClaimRefusal[] = [];
    for (const item of acceptance) {
        const acceptanceId = item.id ?? '';
        const seen = new Set<string>();
        for (const claim of item.claims ?? []) {
            if (seen.has(claim.id)) {
                refusals.push({ acceptanceId, claimId: claim.id, reason: 'duplicate_id', detail: `claim id '${claim.id}' is declared more than once under ${item.id}` });
                continue;
            }
            seen.add(claim.id);
            if (!claim.check.command.trim()) {
                refusals.push({ acceptanceId, claimId: claim.id, reason: 'empty_command', detail: `claim '${claim.id}' declares no command, so nothing can contradict the statement` });
                continue;
            }
            if (!Number.isInteger(claim.check.expect?.exitCode)) {
                refusals.push({
                    acceptanceId,
                    claimId: claim.id,
                    reason: 'no_expected_outcome',
                    detail: `claim '${claim.id}' declares no expected exit code; a check that cannot fail is not evidence`,
                });
            }
        }
    }
    return refusals;
}

/** The stable id a claim's check carries, so evidence binds to the claim rather than to the command text. */
export function claimCheckId(acceptanceId: string, claimId: string): string {
    return `claim:${acceptanceId}:${claimId}`;
}

/**
 * Every claim, as an ordinary check.
 *
 * Returned in this shape on purpose: the seal's resolver, collector and evidence recorder already do the right things with
 * a `CheckCommand`, so a claim is recorded and bound to the revision exactly like the checks beside it, and its evidence is
 * eligible for the acceptance row without any special path.
 */
export function resolveClaimChecks(root: string, acceptance: AcceptanceCriterion[]): CheckCommand[] {
    const checks: CheckCommand[] = [];
    for (const item of acceptance) {
        if (!item.id) continue;
        for (const claim of item.claims ?? []) {
            checks.push({
                id: claimCheckId(item.id, claim.id),
                source: 'configured',
                name: `claim:${item.id}:${claim.id}`,
                kind: 'claim',
                command: claim.check.command,
                args: claim.check.args ?? [],
                cwd: root,
                timeoutMs: claim.check.timeoutMs ?? 120_000,
                // The expectation travels with the check, so the collector can compare without re-reading the task.
                expectExitCode: claim.check.expect.exitCode,
            });
        }
    }
    return checks;
}

/**
 * What the seal reports about claims: the ones that ran, and the ones whose evidence contradicts the sentence.
 *
 * A claim with **no evidence at all** counts as a failure, not as a pass: the sentence was declared checkable, and nothing
 * checked it. That is the same rule the rest of the evidence machinery applies to a required check, applied to prose.
 */
export function evaluateClaims(
    acceptance: AcceptanceCriterion[],
    evidence: Array<{ checkId?: string; exitCode: number | null }>,
): { ran: ClaimCheckSummary[]; failures: ClaimFailure[] } {
    const ran: ClaimCheckSummary[] = [];
    const failures: ClaimFailure[] = [];
    for (const item of acceptance) {
        if (!item.id) continue;
        for (const claim of item.claims ?? []) {
            const checkId = claimCheckId(item.id, claim.id);
            const summary: ClaimCheckSummary = {
                acceptanceId: item.id,
                claimId: claim.id,
                statement: claim.statement,
                checkId,
                expect: { exitCode: claim.check.expect?.exitCode ?? 0 },
            };
            const found = evidence.find((envelope) => envelope.checkId === checkId);
            if (!found) {
                // The claim's evidence is **absent**, which means the check did not run in this seal. That is not the same
                // as "it disagreed": a claim passes on evidence, and evidence that does not exist cannot be a pass.
                //
                // The one case that is not a failure is a seal that ran an **explicit** check set (`options.checks`), which
                // by definition did not include the project's own checks — so a claim was never asked. Reading that as
                // "false" would make a narrow debug seal report the project's sentences as contradicted, which is exactly
                // the kind of wrong signal this mechanism exists to remove.
                if (evidence.length === 0) continue;
                failures.push({ ...summary, actualExitCode: null, missing: true });
                continue;
            }
            ran.push(summary);
            if (found.exitCode !== summary.expect.exitCode) {
                failures.push({ ...summary, actualExitCode: found.exitCode, missing: false });
            }
        }
    }
    return { ran, failures };
}

/** One sentence per failure, for the surface that reports the seal: the claim, and the command that disagrees with it. */
export function describeClaimFailure(failure: ClaimFailure): string {
    const expected = `exit ${failure.expect.exitCode}`;
    const actual = failure.missing ? 'no evidence was recorded' : `exit ${failure.actualExitCode}`;
    return `claim ${failure.checkId} failed: "${failure.statement}" expected ${expected}, got ${actual}`;
}

/** The identity of the claims a revision was verified against, so a statement edit is visible as a change. */
export function claimsHash(acceptance: AcceptanceCriterion[]): string {
    const payload = acceptance
        .flatMap((item) => (item.claims ?? []).map((claim: ClaimDeclaration) => `${item.id}\\u0000${claim.id}\\u0000${claim.statement}\\u0000${claim.check.command}\\u0000${(claim.check.args ?? []).join(' ')}\\u0000${claim.check.expect?.exitCode ?? ''}`))
        .sort()
        .join('\\u0001');
    return hashContent(payload);
}
