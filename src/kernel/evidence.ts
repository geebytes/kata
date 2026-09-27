/**
 * Evidence — the four types, what each is worth, and what a severity requires.
 *
 * The rule this module encodes: a finding must carry the evidence type that fits it and the strength its severity
 * requires. Requiring a reddening check for *every* finding would be narrower than the truth and would systematically
 * exclude architecture, privacy and threat-model findings, which cannot be reduced to one command.
 */
import type { Evidence, EvidenceType, EvidenceVerdict, Severity } from './types.js';

/** How much a type can carry. The reproducible four outrank concurrence, which no machine can re-run. */
export const EVIDENCE_STRENGTH: Record<EvidenceType, number> = {
    executable_falsifier: 4,
    static_witness: 3,
    cross_artifact_contradiction: 3,
    expert_concurrence: 1,
};

/** Types a verifier can decide again from the artifact alone. */
export const REPRODUCIBLE_TYPES: readonly EvidenceType[] = [
    'executable_falsifier',
    'static_witness',
    'cross_artifact_contradiction',
];

export const MIN_STRENGTH_BY_SEVERITY: Record<Severity, number> = {
    blocking: 4,
    major: 3,
    minor: 1,
    nit: 1,
};

export function isReproducible(type: EvidenceType): boolean {
    return REPRODUCIBLE_TYPES.includes(type);
}

export function strengthOf(type: EvidenceType): number {
    return EVIDENCE_STRENGTH[type];
}


export type Admissibility = { ok: true } | { ok: false; why: string };

/**
 * `expert_concurrence` may not carry a blocking claim on its own: it is the one type that turns "two reviewers said so"
 * into evidence, which is how an omission gets repackaged as proof.
 */
export function admissibleFor(type: EvidenceType, severity: Severity): Admissibility {
    if (strengthOf(type) < MIN_STRENGTH_BY_SEVERITY[severity]) {
        return {
            ok: false,
            why: `${type} carries strength ${strengthOf(type)}, below the ${MIN_STRENGTH_BY_SEVERITY[severity]} a ${severity} claim requires`,
        };
    }
    if (severity === 'blocking' && !isReproducible(type)) {
        return { ok: false, why: `${type} cannot be re-decided from the artifact, so it cannot carry a blocking claim alone` };
    }
    return { ok: true };
}

/** Shape check per type: the fields a verifier needs, so a malformed item is refused before it reaches a verifier. */
export function evidenceShapeProblems(evidence: Evidence): string[] {
    const problems: string[] = [];
    switch (evidence.type) {
        case 'executable_falsifier':
            // **A command-backed check must declare the mutation that reddens it** (`K2`): without one its verdict says a
            // command exited 0, which is not evidence that the check is sensitive to anything.
            if (!evidence.command?.trim()) problems.push('command is required');
            if (!evidence.mutation?.file?.trim()) problems.push('mutation.file is required: a check that cannot be reddened is not evidence');
            if (evidence.mutation?.find === undefined || evidence.mutation.find === '') problems.push('mutation.find is required');
            if (evidence.mutation?.replace === undefined) problems.push('mutation.replace is required');
            break;
        case 'static_witness':
            if (!evidence.ref?.trim()) problems.push('ref is required');
            if (!/^(contains|not-contains):/u.test(evidence.assertion ?? '')) {
                problems.push('assertion must be "contains:<literal>" or "not-contains:<literal>"');
            }
            break;
        case 'cross_artifact_contradiction':
            if (!evidence.a?.trim() || !evidence.b?.trim()) problems.push('a and b are required');
            if (!evidence.literal?.trim()) problems.push('literal is required');
            if (evidence.comparator !== 'literal-in-a-not-b' && evidence.comparator !== 'literal-in-b-not-a') {
                problems.push('comparator is not one of the two accepted forms');
            }
            break;
        case 'expert_concurrence':
            if (!Array.isArray(evidence.reviewers) || evidence.reviewers.length < 2) {
                problems.push('at least two reviewers are required');
            }
            if (!evidence.humanAck?.trim()) problems.push('humanAck is required');
            break;
        default: {
            const never: never = evidence;
            return [`unknown evidence type: ${JSON.stringify(never)}`];
        }
    }
    return problems;
}

export function verdictFor(evidenceId: string, verdicts: readonly EvidenceVerdict[]): EvidenceVerdict | undefined {
    return verdicts.find((verdict) => verdict.evidenceId === evidenceId);
}

