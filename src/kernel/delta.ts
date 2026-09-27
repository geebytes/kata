/**
 * Delta — which claims a change forces back open, and which verdicts survive it.
 *
 * The rule the external review settled and this module implements: modified code objectively is not the code that was
 * reviewed, so nothing may continue to *claim* to be certified. But everything the changed paths do not touch keeps its
 * evidence, because the digests it rests on are byte-identical.
 *
 * Conservative by construction: when a dependency cannot be resolved, nothing is reused and every claim reopens.
 */
import { dependencyDigestsMatch } from './subject.js';
import type { Claim, EvidenceVerdict, Subject } from './types.js';

export function pathDepsOf(claim: Claim): string[] {
    return claim.dependsOn
        .filter((dep) => dep.startsWith('path:'))
        .map((dep) => dep.slice('path:'.length));
}

export function claimDepsOf(claim: Claim): string[] {
    return claim.dependsOn
        .filter((dep) => dep.startsWith('claim:'))
        .map((dep) => dep.slice('claim:'.length));
}

export type Delta = {
    /** Claims whose dependencies are byte-identical, so their verdicts carry over. */
    reusable: string[];
    /** Claims the change forces back open. */
    revalidate: string[];
    underivable: boolean;
    /** The dependency references that could not be resolved, named so the operator can fix the graph. */
    underivableRefs: string[];
    /** Verdicts carried over from the previous freeze. */
    reusedEvidence: string[];
};

export function computeDelta(input: {
    previous?: { subject: Subject; claims: readonly Claim[] };
    next: { subject: Subject; claims: readonly Claim[] };
    verdicts: readonly EvidenceVerdict[];
}): Delta {
    const nextIds = input.next.claims.map((claim) => claim.id);
    const knownClaims = new Set(nextIds);
    const knownPaths = new Set(Object.keys(input.next.subject.pathDigests));
    const underivableRefs: string[] = [];
    for (const claim of input.next.claims) {
        for (const dep of claim.dependsOn) {
            // **Resolvability is checked on the first path too** (measured by the corpus scorer: a claim resting on a path
            // that is not in the subject was certified when there was no previous revision). The rule used to run only
            // after the early return, so it was a check that ran on one of two paths — the class this repository has now
            // repaired seven times, found here by the retired corpus rather than by reading the code.
            if (dep.startsWith('path:') && !knownPaths.has(dep.slice('path:'.length))) {
                underivableRefs.push(`${claim.id} -> ${dep}`);
            }
            if (dep.startsWith('claim:') && !knownClaims.has(dep.slice('claim:'.length))) {
                underivableRefs.push(`${claim.id} -> ${dep}`);
            }
        }
    }
    if (underivableRefs.length > 0) {
        return { reusable: [], revalidate: nextIds, underivable: true, underivableRefs, reusedEvidence: [] };
    }

    if (!input.previous) {
        // Nothing to reuse on a first freeze, and the refs are already known to resolve — so this is the reuse decision
        // only, not an early exit that skips a rule.
        return { reusable: [], revalidate: nextIds, underivable: false, underivableRefs: [], reusedEvidence: [] };
    }

    const previousById = new Map(input.previous.claims.map((claim) => [claim.id, claim]));
    const reusable = new Set<string>();
    // A claim that rests on another claim is reusable only once that one is, so this settles rather than iterating once.
    for (let round = 0; round < 64; round += 1) {
        let progressed = false;
        for (const claim of input.next.claims) {
            if (reusable.has(claim.id)) continue;
            const before = previousById.get(claim.id);
            if (!before) continue;
            if (before.statement !== claim.statement) continue;
            if (!dependencyDigestsMatch(input.previous.subject, input.next.subject, pathDepsOf(claim))) continue;
            if (!claimDepsOf(claim).every((id) => reusable.has(id))) continue;
            reusable.add(claim.id);
            progressed = true;
        }
        if (!progressed) break;
    }

    const reusableIds = input.next.claims.filter((claim) => reusable.has(claim.id)).map((claim) => claim.id);
    const reusableEvidenceIds = new Set(
        input.next.claims
            .filter((claim) => reusable.has(claim.id))
            .flatMap((claim) => claim.evidenceIds),
    );
    const reusedEvidence = input.verdicts
        .filter((verdict) => reusableEvidenceIds.has(verdict.evidenceId) && verdict.verdict === 'supported')
        .map((verdict) => verdict.evidenceId);

    return {
        reusable: reusableIds,
        revalidate: nextIds.filter((id) => !reusable.has(id)),
        underivable: false,
        underivableRefs: [],
        reusedEvidence,
    };
}
