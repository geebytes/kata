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

/**
 * What each evidence item currently counts as, derived from every reading of it.
 *
 * **The rule, and why it is this rule.** Once two independent runs can both be recorded (which is the point of keeping
 * readings per run), one item has more than one answer, and something has to decide which the claim is judged on:
 *
 *   1. **A refuted reading wins.** A reproducible counterexample is not a matter of opinion to be outvoted — the kernel
 *      already refuses to let a quorum cancel one ("a reproducible finding is never voted away"), and the alternative here
 *      would be that recording a second, more optimistic reading launders a refuted item into a supported one.
 *   2. Otherwise the **newest** reading wins, ordered by `at`, then by position, then by run id — a total order, so the
 *      answer does not depend on the order the document happens to list its readings in.
 *
 * The projection returns one entry per evidence item, so a consumer that wants "the answer" keeps the shape it had. It
 * removes nothing from the store: `readings` is what the document holds, and this is a view of it.
 */
export type ProjectionOptions = {
    /**
     * The subject revision the decision is about, when the caller knows it.
     *
     * **Why the projection is told this.** A reading carries the revision it was taken against, and the kernel's own rule
     * elsewhere is that a verdict about one revision says nothing about another (`evidence_stale_subject`). Leaving that out
     * of the projection produced a permanent false fail, measured by an independent review: a refutation of an older
     * revision outranked support for the current one, and because the store only drops verdicts whose evidence item changed,
     * re-reading — the remedy `decide` names — could never clear it. When no current revision is known, every reading
     * competes, which is what a ledger without a frozen subject looks like.
     */
    currentRevision?: string | null;
};

/**
 * What each evidence item currently counts as, derived from every reading of it.
 *
 * **The rule, in the order it is applied**, so that a reader can predict the answer without reading the code:
 *
 *   1. **A reading about the current revision outranks a reading about another one.** A refutation of content that no
 *      longer exists cannot veto the content that does; and a stale reading can still be reported as stale when it is the
 *      only thing there is.
 *   2. Among readings on the same side of that line, **a refutation wins.** A reproducible counterexample is not a matter
 *      of opinion to be outvoted — the kernel refuses to let a quorum cancel one — and the alternative would be that
 *      recording a second, more optimistic reading launders a refuted item into a supported one.
 *   3. Otherwise the **newest** reading wins, by a timestamp that must parse: a relayed reading's `at` is a string its
 *      author wrote, and `"zzz"` must not be able to claim to be the latest. An unparseable timestamp orders last.
 *   4. Then the **run id**, then the **verdict's own strength**, then **`observed`** — a chain that is total for any two
 *      readings that differ in anything this rule reads, so the answer never depends on the order of the document. Two
 *      readings that agree on all of it are interchangeable for the decision, and the first is reported.
 *
 * The projection returns one entry per evidence item, ordered by item, so a consumer that wants "the answer" keeps the shape
 * it had. It removes nothing from the store: `readings` is what the document holds, and this is a view of it.
 */
export function projectVerdicts(readings: readonly EvidenceVerdict[], options: ProjectionOptions = {}): EvidenceVerdict[] {
    const currentRevision = options.currentRevision ?? null;
    // **The same region rule the quorum gets, from the same function.** When nothing was read against the current revision
    // the whole list is considered, which is how an item is reported stale rather than silently dropped.
    const region = readingsForRevision(readings, currentRevision);
    const pool = region.length > 0 ? region : readings;
    const chosen = new Map<string, EvidenceVerdict>();
    for (const reading of pool.entries()) {
        const held = chosen.get(reading[1].evidenceId);
        if (held === undefined || supersedes(reading[1], held, currentRevision)) chosen.set(reading[1].evidenceId, reading[1]);
    }
    // **Sorted by item, so the view is deterministic in order as well as in content.** First-seen order would make the
    // list's own order depend on how the document happened to be written, and a reader that shows it would show a different
    // document for the same readings. Measured by a case that reverses the input: the answers agreed, the order did not.
    return [...chosen.values()].sort((left, right) => (left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0));
}

/**
 * The readings that speak for the revision being decided: the ones taken against it.
 *
 * **One derivation, two consumers, because two consumers were answering it differently and the difference was a defect.**
 * The projection needs it to know which readings can decide an item (the quorum's face of the same rule is below), and the
 * quorum needs it to count independent runs — measured by an independent review: handing the quorum *every* reading let a
 * reading the ledger itself called `stale` count as one of the two reviewers the `security` tier asks for, so the tier
 * passed on a reading nothing else in the kernel would decide on.
 *
 * A ledger with no frozen subject has no region, and then every reading is a candidate — the same answer the projection
 * gives, so the two never disagree about which readings are in play.
 */
export function readingsForRevision(readings: readonly EvidenceVerdict[], currentRevision: string | null): EvidenceVerdict[] {
    if (currentRevision === null) return [...readings];
    return readings.filter((reading) => reading.subjectRevision === currentRevision);
}

/** Whether `candidate` is the reading this item should be judged on, given `held` already holds one. */
function supersedes(candidate: EvidenceVerdict, held: EvidenceVerdict, currentRevision: string | null): boolean {
    if (currentRevision !== null) {
        const candidateIsCurrent = candidate.subjectRevision === currentRevision;
        const heldIsCurrent = held.subjectRevision === currentRevision;
        if (candidateIsCurrent !== heldIsCurrent) return candidateIsCurrent;
    }
    const candidateRefuted = candidate.verdict === 'refuted';
    const heldRefuted = held.verdict === 'refuted';
    if (candidateRefuted !== heldRefuted) return candidateRefuted;
    const candidateAt = instant(candidate.at);
    const heldAt = instant(held.at);
    if (candidateAt !== heldAt) return candidateAt > heldAt;
    const candidateRun = candidate.producer?.runId ?? '';
    const heldRun = held.producer?.runId ?? '';
    if (candidateRun !== heldRun) return candidateRun > heldRun;
    const candidateRank = VERDICT_RANK[candidate.verdict] ?? 0;
    const heldRank = VERDICT_RANK[held.verdict] ?? 0;
    if (candidateRank !== heldRank) return candidateRank > heldRank;
    if ((candidate.observed ?? '') !== (held.observed ?? '')) return (candidate.observed ?? '') > (held.observed ?? '');
    // Two more fields a reader can see, so that only readings that agree on everything this rule reads are left to the
    // document's order — measured by an independent review, which found 32 of 4000 random documents reporting a different
    // *instance* per order (the verdict was stable) because these two were not in the chain.
    if (candidate.verifier !== held.verifier) return candidate.verifier > held.verifier;
    return candidate.evidenceType > held.evidenceType;
}

/** When a reading was taken, as a number — and `-Infinity` for a timestamp that does not parse, so junk orders last. */
function instant(at: string | undefined): number {
    const parsed = Date.parse(at ?? '');
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * How strong a verdict is, for the one tie the rest of the chain cannot break: same revision, same moment, same run.
 *
 * `refuted` is decided before this rank is consulted, so it never loses a comparison; the order here only says that a
 * reading which reports something outranks one which reports that it could not tell.
 */
const VERDICT_RANK: Record<EvidenceVerdict['verdict'], number> = { supported: 2, inconclusive: 1, refuted: 0 };


