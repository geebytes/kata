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

/**
 * **What a root-cause verdict owes the next repair, and the reason the circuit breaker did not break.**
 *
 * The packet could already detect a class recurring inside a repair, and it could already ask the round to name a cause.
 * What it could not do was make the answer *actionable*: `evidence: [...]` and `nextAction: 'repair'` are a labelled
 * claim about the past, and the next Build is free to repair one call site again. Measured on one change: five consecutive
 * rounds, three classes, three sites, every repair widening the same enumeration while each reported itself as a
 * class-level fix — the reviewer's conclusion was `instrument_unsound` on all three, and the loop still ran.
 *
 * The obligation is the difference between "you must explain yourself" and "you must say what would make recurrence
 * impossible". It is required **only for the conclusions that route back to repair** — a `claim_scope_error` does not owe
 * a state model, because there is no mechanizable class to close.
 *
 * Every field is a name, not a sentiment: `inventory` must list the sites that exist (so a later round can check whether
 * the repair touched all of them), and `effectivenessTest` must be the check that fails while any site still violates the
 * invariant (so "it is fixed" is decided by running something rather than by the repair's own prose).
 */
export interface ClosureObligation {
    /** The defect class decomposed into the finite states it can be in — the enumeration that replaces site-by-site repair. */
    states: string[];
    /** The one symbol each producer and consumer must derive the fact from. Two symbols is the defect, not the repair. */
    sourceOfTruth: string;
    /** Every producer, consumer, writer and reader of that fact in the repository today. */
    inventory: string[];
    /** The sentence that must be true at every site in the inventory after the repair. */
    invariant: string;
    /** The paths the class-level repair has to touch. */
    repairSurface: string[];
    /** The check that reddens while any site in the inventory still violates the invariant. */
    effectivenessTest: string;
    /** What happens if this class recurs inside a repair again: the exits are terminal, and none of them is a further repair. */
    ifRecursAgain: EscalationExit;
}

/** The terminal exits a stalled or recurring loop may take. None of them is "repair again". */
export const ESCALATION_EXITS = ['rewrite_mechanism', 'waive_with_owner', 'abandon_change'] as const;
export type EscalationExit = (typeof ESCALATION_EXITS)[number];

/** The reviewer's durable conclusion when the request activated the recurrence circuit breaker. */
export type RecurrenceAnalysis = {
    triggerClasses: string[];
    conclusion: RootCauseConclusion;
    evidence: string[];
    nextAction: RootCauseNextAction;
    /** Present exactly when `nextAction` is `repair`: the class-level closure the next Build is contracted to. */
    closureObligation?: ClosureObligation;
};

/** Reject a missing or unbound root-cause conclusion before it can be filed as an ordinary review result. */
export function validateRecurrenceAnalysis(
    value: unknown,
    packet: RecurrencePacket,
): { ok: true; analysis: RecurrenceAnalysis } | { ok: false; why: string; problems: string[] } {
    const problems: string[] = [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        const only = 'recurrencePacket requires a recurrenceAnalysis object';
        return { ok: false, problems: [only], why: only };
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.triggerClasses) || !record.triggerClasses.every((entry): entry is string => typeof entry === 'string')) {
        problems.push('recurrenceAnalysis.triggerClasses must list the triggered classes');
    } else {
        const expected = [...new Set(packet.classes.map((entry) => entry.class))].sort();
        const actual = [...new Set(record.triggerClasses)].sort();
        if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
            problems.push(`recurrenceAnalysis.triggerClasses must name exactly ${expected.join(', ')}`);
        }
    }
    if (typeof record.conclusion !== 'string' || !(ROOT_CAUSE_CONCLUSIONS as readonly string[]).includes(record.conclusion)) {
        problems.push(`recurrenceAnalysis.conclusion must be one of ${ROOT_CAUSE_CONCLUSIONS.join(', ')}`);
    }
    if (!Array.isArray(record.evidence) || record.evidence.length === 0 || !record.evidence.every((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')) {
        problems.push('recurrenceAnalysis.evidence must name at least one concrete record or source reference');
    }
    if (typeof record.nextAction !== 'string' || !(ROOT_CAUSE_NEXT_ACTIONS as readonly string[]).includes(record.nextAction)) {
        problems.push(`recurrenceAnalysis.nextAction must be one of ${ROOT_CAUSE_NEXT_ACTIONS.join(', ')}`);
    }
    if (record.conclusion === 'claim_scope_error' && record.nextAction !== 'restate_claim') {
        problems.push('a claim_scope_error must request restate_claim');
    }
    if ((record.conclusion === 'behaviour_defect' || record.conclusion === 'instrument_unsound' || record.conclusion === 'workflow_routing_error') && record.nextAction !== 'repair') {
        problems.push(`${String(record.conclusion)} must request repair`);
    }
    if (record.conclusion === 'not_same_class' && record.nextAction !== 'resume_certification') {
        problems.push('not_same_class must request resume_certification');
    }
    // **The obligation is required where it is owed, and refused where it is not.** A repair conclusion without a closure
    // obligation is the labelled-but-unactionable verdict this field exists to end; an obligation attached to a
    // `resume_certification` would contract a repair that is not going to happen. Both directions are checked, so the field
    // cannot become decoration.
    problems.push(...closureObligationProblems(record.closureObligation, record.nextAction));
    if (problems.length > 0) {
        return { ok: false, problems, why: problems.join('; ') };
    }
    return {
        ok: true,
        analysis: {
            triggerClasses: [...new Set(record.triggerClasses as string[])].sort(),
            conclusion: record.conclusion as RootCauseConclusion,
            evidence: (record.evidence as string[]).map((entry) => entry.trim()),
            nextAction: record.nextAction as RootCauseNextAction,
            ...(record.closureObligation === undefined
                ? {}
                : { closureObligation: normaliseClosureObligation(record.closureObligation as Record<string, unknown>) }),
        },
    };
}

const OBLIGATION_LIST_FIELDS: ReadonlyArray<{ field: string; what: string }> = [
    { field: 'states', what: 'the finite states the class can be in' },
    { field: 'inventory', what: 'every producer, consumer, writer and reader of the fact' },
    { field: 'repairSurface', what: 'the paths the class-level repair has to touch' },
];

const OBLIGATION_TEXT_FIELDS: ReadonlyArray<{ field: string; what: string }> = [
    { field: 'sourceOfTruth', what: 'the one symbol the fact is derived from' },
    { field: 'invariant', what: 'the sentence that must hold at every site' },
    { field: 'effectivenessTest', what: 'the check that reddens while a site still violates the invariant' },
];

/** Every way a closure obligation can be missing or hollow, each named by the field that is wrong. */
function closureObligationProblems(value: unknown, nextAction: unknown): string[] {
    const owed = nextAction === 'repair';
    if (value === undefined) {
        return owed
            ? ['recurrenceAnalysis.closureObligation is required when nextAction is repair: name the state model, the source of truth, the inventory, the invariant, the repair surface, the effectiveness test, and what happens if the class recurs again']
            : [];
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return ['recurrenceAnalysis.closureObligation must be an object'];
    }
    const record = value as Record<string, unknown>;
    const problems: string[] = [];
    for (const { field, what } of OBLIGATION_LIST_FIELDS) {
        const entry = record[field];
        if (!Array.isArray(entry) || entry.length === 0 || !entry.every((item): item is string => typeof item === 'string' && item.trim() !== '')) {
            problems.push(`recurrenceAnalysis.closureObligation.${field} must name ${what}`);
        }
    }
    for (const { field, what } of OBLIGATION_TEXT_FIELDS) {
        const entry = record[field];
        if (typeof entry !== 'string' || entry.trim() === '') {
            problems.push(`recurrenceAnalysis.closureObligation.${field} must state ${what}`);
        }
    }
    if (typeof record.ifRecursAgain !== 'string' || !(ESCALATION_EXITS as readonly string[]).includes(record.ifRecursAgain)) {
        problems.push(`recurrenceAnalysis.closureObligation.ifRecursAgain must be one of ${ESCALATION_EXITS.join(', ')}`);
    }
    if (!owed) {
        problems.push('recurrenceAnalysis.closureObligation is only meaningful when nextAction is repair; a round that is not repairing owes no closure contract');
    }
    return problems;
}

function normaliseClosureObligation(record: Record<string, unknown>): ClosureObligation {
    const strings = (field: string): string[] => (record[field] as string[]).map((entry) => entry.trim());
    return {
        states: strings('states'),
        sourceOfTruth: (record.sourceOfTruth as string).trim(),
        inventory: strings('inventory'),
        invariant: (record.invariant as string).trim(),
        repairSurface: strings('repairSurface'),
        effectivenessTest: (record.effectivenessTest as string).trim(),
        ifRecursAgain: record.ifRecursAgain as EscalationExit,
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
