/**
 * The judgment foundation: what makes a review conclusion admissible.
 *
 * The gate this replaces returned `satisfied: true` without ever reading `verdict` or `attempts[].outcome` — verified by
 * counting consumers, not by reading the code hopefully. So the smallest record that passed a strict node was one
 * declaring `verdict: "inconclusive"` with an empty findings list: a reviewer stating *"I did not reach a conclusion"*
 * and the node passing anyway. The judgment foundation had no representation for "not concluded", which is a **missing
 * state** rather than a quality risk.
 *
 * The fix is deliberately not "validate the verdict field". A field the reviewer writes is the same defect one level up:
 * it would move the trust from `findings` to `verdict` and leave the review just as unaccountable. Here the reviewer
 * supplies hypotheses and observations — the part that genuinely needs semantic reasoning and counterexample
 * construction — and **kata derives the verdict from them**.
 *
 * Five conjuncts, each a predicate over the record rather than a sentence in a brief:
 *
 *     covered     every acceptance criterion and every changed path is claimed by ≥1 hypothesis
 *     discharged  every hypothesis reached refuted | confirmed | ruled_out, with a cited observation
 *     grounded    every observation resolves at this revision (source path+hunk, evidence id, declared test)
 *     bounded     no hypothesis was abandoned to a resource limit while the verdict is a pass
 *     consistent  no confirmed defect is absent from findings
 */

/** Where an observation points, and how the grounding conjunct checks it. */
export type ObservationKind =
    /** A path (with optional `#Lx-Ly`) that must exist in the revision under review. */
    | 'source'
    /** An evidence envelope id bound to this revision. */
    | 'evidence'
    /** A check id + selector the matrix declares. */
    | 'test'
    /** A deterministic analyzer whose result is recorded. */
    | 'analysis';

export interface ReviewObservation {
    kind: ObservationKind;
    /** The reference the grounding check resolves; its shape depends on `kind`. */
    ref: string;
    /** What was actually observed — not what was expected. Free prose, and it is not the conclusion. */
    observed: string;
}

export interface ReviewHypothesis {
    id: string;
    /** What the reviewer asserts is false. */
    claim: string;
    /** The criteria and/or paths this hypothesis speaks for; coverage is computed from the union of these. */
    targets: string[];
    method: 'mutation' | 'source-read' | 'sealed-evidence' | 'permitted-test' | 'deterministic-analysis';
    outcome: 'refuted' | 'confirmed' | 'ruled_out' | 'abandoned' | 'inconclusive';
    /** Required unless the hypothesis was abandoned or left inconclusive. */
    observation?: ReviewObservation;
    /** Required when `outcome === 'abandoned'`: which limit stopped it, and why. */
    abandoned?: { limit: 'budget' | 'time' | 'tools'; why: string };
}

export interface ReviewStateFinding {
    id: string;
    severity: 'blocking' | 'major' | 'minor' | 'nit';
    message: string;
    path?: string;
}

/** The artifact a pass must produce. Coverage and hypotheses are the record; the verdict is not part of it. */
export interface ReviewState {
    /** What this pass claims to have covered. A claim the gate falsifies against the revision, not an opinion. */
    coverage: Array<{ criterionId: string | null; paths: string[] }>;
    hypotheses: ReviewHypothesis[];
    findings: ReviewStateFinding[];
}

/** What the revision under review actually contains, in the terms the conjuncts are checked against. */
export interface RevisionUnderReview {
    revisionId: string;
    /** Every path this revision changed — derived from content identity, never from the ownership declaration. */
    changedPaths: string[];
    /** The acceptance criteria the revision must answer for. */
    criterionIds: string[];
    /** The test selectors the task declares, for the `test` observation kind. */
    declaredTestSelectors?: string[];
    /** Evidence envelope ids bound to this revision, for the `evidence` observation kind. */
    evidenceIds?: string[];
    /**
     * The check commands the task itself declares, for the `analysis` observation kind.
     *
     * Without this the `analysis` kind had no registry to resolve against, so its grounding rule collapsed to "the ref is
     * a non-empty string" — a citation-free discharge path that made the other three kinds moot: a hypothesis could name
     * any analyzer that does not exist and still ground. An analysis citation must name something the *task* declared as
     * an instrument, which is the same standard the `test` kind already holds citations to.
     */
    declaredInstruments?: string[];
    /** Resolvable paths at this revision; defaults to `changedPaths` when the caller has no fuller list. */
    readablePaths?: string[];
}

export type DerivedVerdict = 'no_defect_found' | 'defects_found' | 'inconclusive' | 'budget_exhausted';

export interface AdmissibilityResult {
    admissible: boolean;
    verdict: DerivedVerdict;
    /** Why, in the terms of the conjunct that failed — so a caller renders the reason instead of re-deriving it. */
    reason?: string;
    /** Criteria and paths no hypothesis claimed. */
    uncovered: string[];
    /** Hypothesis ids whose observation is missing or does not resolve. */
    ungrounded: string[];
    /** Hypothesis ids that did not converge (`inconclusive` outcome). */
    open: string[];
    /** Hypothesis ids stopped by a limit. */
    abandoned: string[];
}

const TERMINAL_OUTCOMES: ReadonlySet<ReviewHypothesis['outcome']> = new Set(['refuted', 'confirmed', 'ruled_out']);

/**
 * The verdict implied by the hypotheses alone.
 *
 * This is **not** the whole answer, and the distinction matters: coverage and grounding are predicates against the
 * revision, which this function deliberately does not see. `evaluateAdmissibility` calls it and then refuses to certify
 * anything the other conjuncts do not support — an incomplete state's verdict is `inconclusive` regardless of what its
 * hypotheses say. Keeping the split is what stops the two from drifting: there is exactly one place that decides
 * admissibility, and this is only the hypothesis half of it.
 *
 * Order matters and is deliberate: an abandoned hypothesis outranks everything (a limit hit is a fact about the round,
 * not about the code), then incompleteness, then a confirmed defect. A pass that both abandoned a hypothesis and
 * confirmed a defect reports `budget_exhausted`, because the caller must know the search was cut short before it acts on
 * what was found.
 */
export function deriveVerdict(state: ReviewState): DerivedVerdict {
    const abandoned = state.hypotheses.some((hypothesis) => hypothesis.outcome === 'abandoned');
    if (abandoned) return 'budget_exhausted';
    const discharged = state.hypotheses.every((hypothesis) => TERMINAL_OUTCOMES.has(hypothesis.outcome) && hypothesis.observation !== undefined);
    if (!discharged) return 'inconclusive';
    const confirmed = state.hypotheses.some((hypothesis) => hypothesis.outcome === 'confirmed');
    return confirmed ? 'defects_found' : 'no_defect_found';
}

/** Whether an observation can be opened at this revision. Narrow by construction, and never satisfied by confidence. */
function resolves(observation: ReviewObservation, revision: RevisionUnderReview): boolean {
    const readable = new Set(revision.readablePaths ?? revision.changedPaths);
    const pathOf = (ref: string): string => ref.split('#')[0] ?? ref;
    switch (observation.kind) {
        case 'source':
            return readable.has(pathOf(observation.ref));
        case 'evidence':
            return (revision.evidenceIds ?? []).includes(observation.ref);
        case 'test':
            return (revision.declaredTestSelectors ?? []).includes(observation.ref.split(' ')[0] ?? observation.ref);
        case 'analysis':
            // R8 (2026-09-22, found by an adversarial pass): this was `observation.ref.trim().length > 0`, which admitted
            // `{kind:'analysis', ref:'q', observed:'z'}` with `satisfied: true`. An analysis citation must name an
            // instrument the task declared — a named checker, not any non-empty string.
            return (revision.declaredInstruments ?? []).includes(observation.ref.trim());
}
}

/**
 * Evaluate a review state against the revision it claims to be about.
 *
 * The five conjuncts are evaluated in the order a reader would ask them, and the first failure names itself: coverage,
 * then discharge, then grounding, then boundedness, then consistency. All four diagnostic sets are returned on every
 * call — a caller that gets one refusal should still be able to render the whole picture without a second pass.
 */
export function evaluateAdmissibility(state: ReviewState, revision: RevisionUnderReview): AdmissibilityResult {
    // The hypothesis half first; the conjuncts below may override it, and that override is the whole point — a state
    // whose hypotheses all discharged still cannot certify a conclusion it never covered.
    const hypothesisVerdict = deriveVerdict(state);

    const abandoned = state.hypotheses.filter((hypothesis) => hypothesis.outcome === 'abandoned').map((hypothesis) => hypothesis.id);
    const open = state.hypotheses
        .filter((hypothesis) => hypothesis.outcome === 'inconclusive' || (TERMINAL_OUTCOMES.has(hypothesis.outcome) && hypothesis.observation === undefined))
        .map((hypothesis) => hypothesis.id);
    const ungrounded = state.hypotheses
        .filter((hypothesis) => hypothesis.observation !== undefined && !resolves(hypothesis.observation, revision))
        .map((hypothesis) => hypothesis.id);

    // Coverage: the union of every hypothesis's targets must contain every criterion and every changed path.
    const claimed = new Set(state.hypotheses.flatMap((hypothesis) => hypothesis.targets));
    const covered = new Set(state.coverage.flatMap((entry) => [entry.criterionId, ...entry.paths]).filter((value): value is string => Boolean(value)));
    const uncovered = [
        ...revision.criterionIds.filter((id) => !claimed.has(id) && !covered.has(id)),
        ...revision.changedPaths.filter((path) => !claimed.has(path) && !covered.has(path)),
    ];

    // A refused state is never certified: `budget_exhausted` survives as itself because it names the actual reason the
    // round stopped (a limit), and everything else that cannot be admitted is `inconclusive`.
    const refusedVerdict: DerivedVerdict = hypothesisVerdict === 'budget_exhausted' ? 'budget_exhausted' : 'inconclusive';
    const refuse = (reason: string): AdmissibilityResult => ({ admissible: false, verdict: refusedVerdict, reason, uncovered, ungrounded, open, abandoned });

    if (abandoned.length > 0) {
        return refuse(`a hypothesis was abandoned to a limit (${abandoned.join(', ')}), so this round did not conclude`);
    }
    if (uncovered.length > 0) {
        return refuse(`the state does not cover: ${uncovered.join(', ')}`);
    }
    if (state.hypotheses.length === 0) {
        return refuse('no hypothesis was recorded, so nothing was looked at');
    }
    if (open.length > 0) {
        return refuse(`hypothesis ${open.join(', ')} did not converge and carries no observation`);
    }
    if (ungrounded.length > 0) {
        return refuse(`the observation for ${ungrounded.join(', ')} does not resolve at ${revision.revisionId}`);
    }

    // Consistency: a confirmed defect must appear in findings. A state that confirms one and omits it is decorating an
    // answer with a real observation while the deliverable stays unchanged.
    const confirmed = state.hypotheses.filter((hypothesis) => hypothesis.outcome === 'confirmed');
    if (confirmed.length > 0 && state.findings.length === 0) {
        return refuse(`${confirmed.length} hypothesis(es) confirmed a defect but no finding was reported`);
    }

    return { admissible: true, verdict: hypothesisVerdict, uncovered, ungrounded, open, abandoned };
}
