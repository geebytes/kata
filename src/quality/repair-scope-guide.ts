import { repairScopes, type RepairScope } from './judge.js';

/**
 * The scope guide the repair loop shows. Keyed by the repair vocabulary so a new scope fails compilation until it is
 * documented here, and the generated skill text cannot lag behind the Judge.
 */
const repairScopeGuide: Record<RepairScope, string> = {
    missing_test_evidence: 'write a test for the acceptance criterion',
    revision_superseded: 'a declared task-owned path changed after sealing; rebuild to create the next revision',
    stale_evidence: 'legacy repository-scoped evidence changed after collection; rebuild',
    failing_evidence: 'tests or checks failed',
    blocking_review_finding: 'a reviewer blocked this acceptance',
    cross_revision_evidence: 'the acceptance is covered by evidence from more than one revision; seal one revision',
    insufficient_evidence_level: 'the acceptance requires integration or entrypoint evidence that is missing; add it',
    unresolved_repair_obligation: 'a repair obligation from the review or the Judge is still unresolved',
};


/**
 * The repair-scope vocabulary as prose, beside the vocabulary it describes.
 *
 * It lived in the skill renderer, which is where the sentence is *used* rather than where the list is *defined*; moving
 * it here keeps the pair together and lets the phase-guidance catalogue render it after L6-02 moved the prose out.
 */
export function renderRepairScopeGuide(): string {
    return repairScopes
        .map((scope) => `   - \`${scope}\` — ${repairScopeGuide[scope]}`)
        .join('\n');
}
