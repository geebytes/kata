import { checkInputFingerprint, type CheckCommand, type EvidenceEnvelope } from './evidence.js';

/**
 * Which checks a seal may skip, and why it may skip them (L1-01).
 *
 * The rule the review asked for, made executable: a check is reusable when **its own inputs** and the acceptance rows it
 * was declared against are unchanged, and it previously passed. The seal used to reuse only when *every* recorded
 * envelope still described the current tree, so one changed artefact re-ran the whole set — and because the alternative
 * to proving a check is unaffected is guessing, every uncertain case invalidates. Absence of a fingerprint is an
 * invalidation, not an assumption of sameness.
 *
 * Pure on purpose: no filesystem, no clock, no revision lookup. The caller supplies the recorded envelopes and the
 * declarations, which is what makes the decision testable without sealing anything.
 */
export interface CheckReusePlan {
    /** Each check that will not run, with the envelope that licenses skipping it. */
    reusable: Array<{ checkId: string; envelopeId: string }>;
    /** Checks that have an envelope and are still going to run, with the reason. Reported, never silent. */
    invalidated: Array<{ checkId: string; reason: 'previously_failed' | 'no_input_fingerprint' | 'input_changed' | 'no_envelope' }>;
    /** Every declared check, in declaration order, with the reusable ones carrying `importResult`. */
    planned: CheckCommand[];
}

/** The id a check is addressed by, matching how the revision was computed over the same set. */
export function reusableCheckId(check: CheckCommand): string {
    return check.id ?? `${check.kind}:${check.command}:${(check.args ?? []).join(' ')}`;
}

export function planCheckReuse(checks: CheckCommand[], recorded: EvidenceEnvelope[]): CheckReusePlan {
    const reusable: CheckReusePlan['reusable'] = [];
    const invalidated: CheckReusePlan['invalidated'] = [];
    const byId = new Map(recorded.map((envelope) => [envelope.checkId, envelope]));
    const planned: CheckCommand[] = [];

    for (const check of checks) {
        const checkId = reusableCheckId(check);
        const previous = byId.get(checkId);

        if (!previous) {
            invalidated.push({ checkId, reason: 'no_envelope' });
            planned.push(check);
            continue;
        }
        if (previous.passed !== true) {
            invalidated.push({ checkId, reason: 'previously_failed' });
            planned.push(check);
            continue;
        }
        if (!previous.checkInput) {
            // Written before fingerprints existed. Reusing it would assert an input identity nobody recorded.
            invalidated.push({ checkId, reason: 'no_input_fingerprint' });
            planned.push(check);
            continue;
        }
        if (previous.checkInput !== checkInputFingerprint(check)) {
            invalidated.push({ checkId, reason: 'input_changed' });
            planned.push(check);
            continue;
        }

        reusable.push({ checkId, envelopeId: previous.id });
        planned.push({
            ...check,
            // The existing seam for a known outcome: the collector records it without spawning anything.
            importResult: {
                exitCode: previous.exitCode,
                ...(previous.log ? { log: previous.log } : {}),
                ...(previous.environment ? { environment: previous.environment } : {}),
            },
            reusedFrom: previous.id,
        });
    }

    return { reusable, invalidated, planned };
}
