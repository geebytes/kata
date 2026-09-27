/**
 * Kernel types — the vocabulary of the new review subsystem.
 *
 * This module is pure: it declares data, not behaviour, and it names no platform, no session and no process. The whole
 * kernel is the only thing every platform must implement together, so anything that describes *how* a review ran belongs
 * one layer up (`src/producers`, `src/assurance`), never here.
 */

/** The finite risk space a change is challenged across. Replaces "cover every path", which is an open set. */
export const RISK_CLASSES = [
    'assumption',
    'boundary',
    'state_transition',
    'privilege',
    'failure_mode',
    'rollback',
    'concurrency',
    'provenance',
    'dependency',
    'consistency',
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/**
 * The evidence types.
 *
 * **Four, not five** (`the K2 gap`). The fifth was `invariant_proof`: a command that exits 0 when an invariant holds. It
 * was a weaker spelling of the type beside it — the only difference is whether the author declares the mutation that
 * makes the check fail — and the weaker spelling had no mutation field at all, so a check that could never fail was
 * admissible and carried a claim to `pass` (measured: `bash -c "exit 0"` verified as supported). Since the whole point of
 * a check is that it can fail, the type that could not say so is gone rather than given a second rule to remember. A
 * property test or type-level invariant is now expressed as a falsifier whose mutation violates it.
 */
export const EVIDENCE_TYPES = [
    'executable_falsifier',
    'static_witness',
    'cross_artifact_contradiction',
    'expert_concurrence',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Process assurance grades. `observed` and above can support confidentiality claims; the lower ones cannot. */
export const ASSURANCE_LEVELS = ['none', 'relayed', 'observed', 'sandboxed', 'signed'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

/** Assurance is an ordered ladder, not a set of allowed values: a round that is *better* observed than required passes. */
export const ASSURANCE_RANK: Record<AssuranceLevel, number> = { none: 0, relayed: 1, observed: 2, sandboxed: 3, signed: 4 };

export function assuranceAtLeast(recorded: AssuranceLevel, floor: AssuranceLevel): boolean {
    return ASSURANCE_RANK[recorded] >= ASSURANCE_RANK[floor];
}

export const SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type TierName = 'standard' | 'strict' | 'security';
export const TIER_NAMES: readonly TierName[] = ['standard', 'strict', 'security'];

/**
 * A content-addressed freeze. Any change to any declared path yields a different revision.
 *
 * **`declaredPaths` is what makes drift re-checkable.** Freezing expands a declared directory into the files it holds, so
 * the digest map is a *result* of the declaration and cannot be inverted: a file added inside a declared directory after
 * the freeze is not a key in `pathDigests`, and re-freezing those keys therefore cannot notice it. Keeping the declaration
 * means drift is measured against the surface that was declared rather than against the surface that happened to exist,
 * which is the difference between "nothing in this directory changed" and "nothing I could see changed".
 */
export type Subject = {
    revision: string;
    pathDigests: Record<string, string>;
    /** The paths as declared, before directory expansion. Absent on subjects frozen before the field existed. */
    declaredPaths?: string[];
};

/** A dependency entry is either a path this claim rests on, or another claim it builds on. Prefixes keep them apart. */
export type DependencyRef = `path:${string}` | `claim:${string}`;

export type ClaimStatus = 'open' | 'supported' | 'refuted' | 'insufficient' | 'waived';

export type Claim = {
    id: string;
    statement: string;
    riskClass: RiskClass;
    /** How much this claim matters; the severity decides the minimum evidence strength it must carry. */
    severity: Severity;
    /** What this claim rests on. An entry that cannot be resolved makes the dependency cone underivable. */
    dependsOn: DependencyRef[];
    evidenceIds: string[];
    challengeIds: string[];
    status: ClaimStatus;
    /**
     * When the claim was declared, stamped by the store rather than by a caller: the store is the only writer that
     * knows the time, and an empty value means "not yet stamped".
     */
    at: string;
    /**
     * How many times the claim was forced back open. This is the author-side cost the round-shaped loop never
     * measured — repairs were per finding, each minting a revision, and nothing counted the reopens they caused.
     */
    reopens: number;
    waiver?: { reason: string; at: string };
};

export type Evidence =
    | {
        id: string;
        type: 'executable_falsifier';
        /** Removing or injecting the defect must make this command fail. */
        command: string;
        /**
         * The defect this check is sensitive to: inject `find`, expect `command` to redden, restore.
         *
         * **The item carries no revision of its own** (`measured in the type merge`). It used to require one, and nothing
         * read it: the fact that makes a verdict stale is recorded on the *verdict* (`context.subject.revision`), and the
         * kernel compares that against the subject. A second copy on the item was a declaration with no consumer, which
         * is why the requirement looked like a rule and behaved like paperwork.
         */
        mutation: { file: string; find: string; replace: string };
    }
    | {
        id: string;
        type: 'static_witness';
        /** Path relative to the repository root. */
        ref: string;
        /** `contains:<literal>` or `not-contains:<literal>`. */
        assertion: string;
    }
    | {
        id: string;
        type: 'cross_artifact_contradiction';
        a: string;
        b: string;
        literal: string;
        /** Which side must carry the literal and which must not. */
        comparator: 'literal-in-a-not-b' | 'literal-in-b-not-a';
    }
    | {
        id: string;
        type: 'expert_concurrence';
        /** Independent reviewers whose concurrence this is; the kernel does not care who they are. */
        reviewers: string[];
        /** An acknowledgement receipt that must exist; without it this evidence type is not admissible for blocking. */
        humanAck: string;
    };

/**
 * A verdict is produced by a verifier, never by the producer of the evidence. The kernel consumes verdicts and never
 * executes anything, which is what keeps `decide()` a pure function.
 */
/** Which producer decided this item. A verdict carries who decided so two reviewers are two observations, not one. */
export type VerdictProducer = {
    /** The run that produced this verdict. Two verdicts on one item from one run are one observation, not a quorum. */
    runId: string;
    /** The party that did the deciding, recorded verbatim for audit. */
    actor: string;
};

export type EvidenceVerdict = {
    evidenceId: string;
    evidenceType: EvidenceType;
    verdict: 'supported' | 'refuted' | 'inconclusive';
    /** What the verifier observed, verbatim. Prose, kept for audit. */
    observed: string;
    at: string;
    verifier: string;
    /** The revision the verdict is about. A verdict about another revision cannot support a claim about this one. */
    subjectRevision: string;
    /**
     * Who produced this reading, as an immutable pair.
     *
     * **Optional because the reader must describe what is on disk.** Every writer supplies it — the adapters stamp it from
     * the run they hosted — but a ledger recorded before the field existed has verdicts without one, and the store really
     * does read them. A required field here would make the type disagree with the reader that tolerates the absence, which
     * is how a type comes to be trusted about a document nobody can produce. `groupByProducer` is where the absence is
     * handled, and it counts those verdicts as one reading rather than one each.
     */
    producer?: VerdictProducer;
};

export type ChallengeState = 'open' | 'resolved' | 'withdrawn';

/**
 * A counterexample aimed at a claim. `failsOn` is the revision where the command is expected to fail; a challenge whose
 * command also fails on the claimed-fixed revision is not a resolved challenge.
 */
export type Challenge = {
    id: string;
    claimId: string;
    command: string;
    failsOn: string;
    state: ChallengeState;
    at: string;
    resolution?: { at: string; observed: string };
    /**
     * The previous command, kept when a measurement turns out to have been wrong.
     *
     * A counterexample whose command measures the wrong thing — a comment rather than the code, say — must be correctable
     * without hand-editing the ledger, and the correction must not erase what was measured before: that is the difference
     * between amending a measurement and quietly rewriting a record.
     */
    amendment?: { command: string; reason: string; at: string };
    /**
     * Whether this counterexample was ever observed to reproduce.
     *
     * **The field the discovery floor needed.** A challenge whose command exits 0 is *withdrawn* by one check, and the
     * floor used to count every non-open challenge as an independent challenge — so `challenge add --command 'exit 0'`
     * followed by one `challenge check` satisfied the strict floor without anything having been challenged. A
     * counterexample is only a counterexample if it failed at some point, and that failure is a fact the ledger can
     * record: it is set when a check observes a non-zero exit, and it is never cleared, because a reproduction that
     * happened stays a fact about the artifact.
     */
    reproduced?: boolean;
};

export type ReasonCode =
    | 'budget_exhausted'
    | 'assurance_below_tier'
    | 'evidence_refuted'
    | 'evidence_below_strength'
    | 'evidence_inconclusive'
    | 'evidence_stale_subject'
    | 'evidence_missing'
    | 'challenge_open'
    | 'uncovered_risk_class'
    | 'discovery_floor'
    | 'quorum_disputed'
    | 'quorum_undiversified'
    | 'waived_without_reason'
    | 'claim_unsupported'
    | 'quorum_missing'
    | 'discovery_unverified'
    | 'same_actor'
    | 'dependency_unresolvable';

export type Reason = {
    code: ReasonCode;
    detail: string;
    /** The claim the reason is about, when it is about one. */
    claimId?: string;
};

export type Deficit = {
    claimId: string;
    /** What is missing: a strength, a type, or a challenge. */
    need: string;
};

export type Decision = {
    verdict: 'pass' | 'fail' | 'insufficient';
    riskTier: TierName;
    reasons: Reason[];
    /** Evidence whose verdict was about this subject and whose claims were untouched by the change. */
    reusedEvidence: string[];
    /** Claims the change forces back open. */
    revalidateClaims: string[];
    /**
     * Whether reuse was actually decided, or could not be because no previous subject was supplied.
     *
     * **Two facts were being reported with one shape.** With no `previous` subject the delta returns an empty
     * `reusedEvidence` and every claim in `revalidateClaims`, which is the conservative answer — and it is byte-identical
     * to the answer a real comparison gives when nothing happened to be reusable. A reader could not tell "this change
     * reused nothing" from "reuse was never evaluated", on the field whose entire purpose is to say how much work a repair
     * saved. `deltaEvaluated` is that distinction, and it is why the ledger route can report honestly that it does not
     * yet supply the input.
     */
    deltaEvaluated: boolean;
    deficits: Deficit[];
    /** Reported, never silently dropped: a quorum that could not be formed from diverse reviewers. */
    undiversified: boolean;
};

/**
 * Reason wording lives here rather than at each refusal site, so a refusal cannot be reported without a message — the
 * defect class this repository has caught eleven times ("a check that cannot fail" has a sibling: "a refusal with no
 * message"). `whoActs` says which side can clear the reason, which is what keeps pass-facing conditions statable.
 */
export const REASON_MESSAGES: Record<ReasonCode, { message: string; whoActs: 'author' | 'verifier' | 'policy-owner' }> = {
    budget_exhausted: {
        message: 'The budget was spent before the ledger reached a supported state; a spent budget is never a pass.',
        whoActs: 'policy-owner',
    },
    assurance_below_tier: {
        message: 'The process assurance recorded for this subject is below what the tier requires.',
        whoActs: 'policy-owner',
    },
    dependency_unresolvable: {
        message: 'A claim rests on something that cannot be resolved against this subject, so nothing here is checkable.',
        whoActs: 'author',
    },
    evidence_refuted: {
        message: 'An accepted evidence item reports this claim as refuted: the defect it names is present.',
        whoActs: 'author',
    },
    evidence_below_strength: {
        message: 'The evidence for this claim is weaker than the claim\'s severity requires.',
        whoActs: 'author',
    },
    evidence_inconclusive: {
        message: 'The verifier could not decide this evidence; an undecided check supports nothing.',
        whoActs: 'author',
    },
    evidence_stale_subject: {
        message: 'A verdict is about a different revision than the frozen subject, so it cannot support a claim about this one.',
        whoActs: 'author',
    },
    evidence_missing: {
        message: 'A claim names evidence that has no verdict yet.',
        whoActs: 'author',
    },
    challenge_open: {
        message: 'A counterexample aimed at this claim is still open.',
        whoActs: 'author',
    },
    uncovered_risk_class: {
        message: 'The change touches a risk class that no claim covers.',
        whoActs: 'author',
    },
    discovery_floor: {
        message: 'No independent challenge ran for this change; a tier at or above medium requires at least one.',
        whoActs: 'policy-owner',
    },
    quorum_disputed: {
        message: 'Reviewers disagree on this claim and the disagreement is unresolved. A reproducible finding is never voted away.',
        whoActs: 'policy-owner',
    },
    quorum_undiversified: {
        message: 'The quorum was formed from reviewers that are not diverse, so it adds no independent signal.',
        whoActs: 'policy-owner',
    },
    waived_without_reason: {
        message: 'A claim was waived without a recorded reason; a waiver is a decision, and a decision has a reason.',
        whoActs: 'author',
    },
    claim_unsupported: {
        message: 'No verdict supports this claim.',
        whoActs: 'author',
    },
    quorum_missing: {
        message: 'Fewer independent reviewers decided this change than the tier requires, so the multi-reviewer tier contract is unmet.',
        whoActs: 'policy-owner',
    },
    discovery_unverified: {
        message: 'No challenge or probe with a recorded observation ran, so nothing here was independently read.',
        whoActs: 'author',
    },
    same_actor: {
        message: 'The party that approved this change is among the parties that produced its evidence, so the approval is not independent of its own claims.',
        whoActs: 'policy-owner',
    },
};
