import { isDefectClass, oracleFor } from './defect-classes.js';
import { classRecurrence, type ReviewRoundsRead } from './repair.js';

/**
 * A deterministic handoff for the one review that must explain a loop before buying another ordinary certification round.
 *
 * The packet contains only durable review history.  It deliberately does not infer a cause from reviewer prose: the next
 * independent reviewer receives the recurring classes and the exact rounds that produced them, then decides the cause.
 */
export type RecurrencePacket = {
    version: 1;
    mode: 'root_cause';
    trigger: 'mechanizable_class_recurred_after_repair';
    classes: Array<{
        class: string;
        oracle: 'mechanizable';
        repairOrigin: number;
        rounds: string[];
        findings: string[];
    }>;
    rounds: Array<{
        at: string;
        revisionId?: string;
        reviewedRevisionId?: string;
        findings: Array<{ id: string; severity: string; class?: string; origin?: string }>;
    }>;
    sources: {
        reviewRounds: string;
        reviewHistory: string;
        currentReview: string;
    };
};
export const ROOT_CAUSE_CONCLUSIONS = [
    'behaviour_defect',
    'instrument_unsound',
    'claim_scope_error',
    'workflow_routing_error',
    'not_same_class',
] as const;
export type RootCauseConclusion = (typeof ROOT_CAUSE_CONCLUSIONS)[number];

export const ROOT_CAUSE_NEXT_ACTIONS = ['repair', 'restate_claim', 'resume_certification'] as const;
export type RootCauseNextAction = (typeof ROOT_CAUSE_NEXT_ACTIONS)[number];

/** The reviewer's durable conclusion when the request activated the recurrence circuit breaker. */
export type RecurrenceAnalysis = {
    triggerClasses: string[];
    conclusion: RootCauseConclusion;
    evidence: string[];
    nextAction: RootCauseNextAction;
};

/** Reject a missing or unbound root-cause conclusion before it can be filed as an ordinary review result. */
export function validateRecurrenceAnalysis(
    value: unknown,
    packet: RecurrencePacket,
): { ok: true; analysis: RecurrenceAnalysis } | { ok: false; why: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, why: 'recurrencePacket requires a recurrenceAnalysis object' };
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.triggerClasses) || !record.triggerClasses.every((entry): entry is string => typeof entry === 'string')) {
        return { ok: false, why: 'recurrenceAnalysis.triggerClasses must list the triggered classes' };
    }
    const expected = [...new Set(packet.classes.map((entry) => entry.class))].sort();
    const actual = [...new Set(record.triggerClasses)].sort();
    if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
        return { ok: false, why: `recurrenceAnalysis.triggerClasses must name exactly ${expected.join(', ')}` };
    }
    if (typeof record.conclusion !== 'string' || !(ROOT_CAUSE_CONCLUSIONS as readonly string[]).includes(record.conclusion)) {
        return { ok: false, why: `recurrenceAnalysis.conclusion must be one of ${ROOT_CAUSE_CONCLUSIONS.join(', ')}` };
    }
    if (!Array.isArray(record.evidence) || record.evidence.length === 0 || !record.evidence.every((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')) {
        return { ok: false, why: 'recurrenceAnalysis.evidence must name at least one concrete record or source reference' };
    }
    if (typeof record.nextAction !== 'string' || !(ROOT_CAUSE_NEXT_ACTIONS as readonly string[]).includes(record.nextAction)) {
        return { ok: false, why: `recurrenceAnalysis.nextAction must be one of ${ROOT_CAUSE_NEXT_ACTIONS.join(', ')}` };
    }
    if (record.conclusion === 'claim_scope_error' && record.nextAction !== 'restate_claim') {
        return { ok: false, why: 'a claim_scope_error must request restate_claim' };
    }
    if ((record.conclusion === 'behaviour_defect' || record.conclusion === 'instrument_unsound' || record.conclusion === 'workflow_routing_error') && record.nextAction !== 'repair') {
        return { ok: false, why: `${record.conclusion} must request repair` };
    }
    if (record.conclusion === 'not_same_class' && record.nextAction !== 'resume_certification') {
        return { ok: false, why: 'not_same_class must request resume_certification' };
    }
    return {
        ok: true,
        analysis: {
            triggerClasses: actual,
            conclusion: record.conclusion as RootCauseConclusion,
            evidence: record.evidence.map((entry) => entry.trim()),
            nextAction: record.nextAction as RootCauseNextAction,
        },
    };
}


/**
 * Produce a root-cause packet only for the measured recurrence shape: a mechanizable class appearing in more than one
 * round, at least once inside a previous repair.  Missing or unreadable history is never promoted into a recurrence.
 */
export function recurrencePacketOfReadable(
    state: ReviewRoundsRead,
    sources: RecurrencePacket['sources'],
): RecurrencePacket | null {
    if (state.kind !== 'readable') return null;

    const classes = classRecurrence(state.rounds)
        .filter((entry) => entry.stopLineCandidate && isDefectClass(entry.class) && oracleFor(entry.class) === 'mechanizable')
        .map((entry) => ({
            class: entry.class,
            oracle: 'mechanizable' as const,
            repairOrigin: entry.repairOrigin,
            rounds: entry.rounds,
            findings: entry.findings,
        }));
    if (classes.length === 0) return null;

    const names = new Set(classes.map((entry) => entry.class));
    const rounds = state.rounds.flatMap((round) => {
        const findings = (round.findings ?? []).filter((finding) => finding.class !== undefined && names.has(finding.class));
        if (findings.length === 0) return [];
        return [{
            at: round.at,
            ...(round.revisionId === undefined ? {} : { revisionId: round.revisionId }),
            ...(round.reviewedRevisionId === undefined ? {} : { reviewedRevisionId: round.reviewedRevisionId }),
            findings,
        }];
    });

    return {
        version: 1,
        mode: 'root_cause',
        trigger: 'mechanizable_class_recurred_after_repair',
        classes,
        rounds,
        sources,
    };
}
