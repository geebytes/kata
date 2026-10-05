/**
 * One place that turns a ledger into a decision.
 *
 * Two consumers need it — the CLI's `decide` verb and the ladder's next-action suggestion — and computing it twice would
 * be the defect this subsystem exists to remove: one fact derived in two places, one updated and the other missed. So the
 * assembly lives here and both callers ask.
 *
 * `absent` is a state rather than an error. A change with no ledger is judged by whatever path it had before, and the
 * caller can see which one answered — which is what keeps the old route visible while it is being retired, instead of
 * silently deciding by whichever code path happened to run. `unreadable` is separate from `absent` on purpose: a ledger
 * that exists and cannot be parsed must not be indistinguishable from one that was never written.
 */
import { readLedger, declaredPaths, readProbeAnswers, type Ledger } from './ledger.js';
import { decide, evaluateClaim, type ClaimEvaluation, type QuorumReport } from '../kernel/decide.js';
import { readingsForRevision } from '../kernel/evidence.js';
import { aggregateQuorum, groupByProducer, type QuorumRecord } from '../kernel/quorum.js';
import { classifyRisk, resolveTier } from '../kernel/risk.js';
import type { AssuranceLevel, Decision, EvidenceVerdict, Severity, TierName } from '../kernel/types.js';
import type { Challenge } from '../kernel/types.js';
import type { ProbeAnswer } from '../kernel/discovery.js';

/**
 * How many of the recorded challenges actually ran.
 *
 * The count that feeds the discovery floor used to be "every challenge that is not open, plus every probe answer", and
 * both halves were satisfiable by doing nothing: a challenge whose command is `exit 0` is withdrawn by one check, and an
 * answer was a string nobody compared against the question. So the floor is computed from evidence of a measurement:
 *
 *   - a **terminal** challenge counts when its persisted `resolution.observed` is non-blank; execution is what the
 *     discovery floor proves, while `reproduced` remains historical counterexample information;
 *   - a **probe answer** counts when it records a non-blank command and observation, de-duplicated by the command it ran.
 *     **What this half does not prove, and what the comment here used to claim:** the code does not compare the
 *     observation against the fact the probe asked for (the digest prefix, or the path), because an answer carries neither
 *     the kind nor the path. So an arbitrary observation still counts as one reading. Adding that comparison is a
 *     behaviour change with its own review; until then the honest statement is that this half proves an answer was
 *     recorded, not that it was right.
 */
export function verifiedChallengeCount(challenges: readonly Challenge[], answers: readonly ProbeAnswer[]): number {
    let verified = 0;
    for (const challenge of challenges) {
        // A terminal challenge proves discovery only after its check persisted a non-blank observation. `reproduced`
        // records whether that measurement ever found a counterexample; requiring it here would make an honest passing
        // independent check ineligible and pressure reviewers to manufacture a current failure.
        if (challenge.state !== 'withdrawn' && challenge.state !== 'resolved') continue;
        // **The field is tested before it is used, because nothing else tests it.** `challenges.json` is registered
        // `internal` with no schema, so a record may carry a `resolution` without an `observed`, or carry a non-string
        // there — a legacy or hand-repaired ledger is exactly where such a record lives. Checking the type keeps that
        // state on the refusing path it belongs to; dereferencing it turned a promised refusal into a `TypeError` inside
        // every surface that reads the ledger, which is worse than the state it was meant to reject.
        const observed = challenge.resolution?.observed;
        if (typeof observed !== 'string' || observed.trim() === '') continue;
        verified += 1;
    }
    // **Distinct questions, not distinct answer records.** Counting answers let the same question answered twice satisfy
    // the floor twice — and the generator could produce such duplicates, which is how it was found: a real change asked six
    // probes of which three pairs were identical, and the floor read six. Identity is the question itself (its kind and the
    // path it is about), so the count is of independent readings whatever produced the list.
    const askedQuestion = new Set<string>();
    for (const answer of answers) {
        // **Both fields are tested before they are used, for the same reason the challenge half tests its own.**
        // `probe-answers.json` is registered `internal` with no schema, so an answer may carry a `command` without an
        // `observed`, or carry a non-string in either — a legacy or hand-repaired ledger is where such a record lives.
        // This branch had the identical unguarded dereference the challenge branch above was repaired for, one line
        // below it, and the same repair applies: keep the record on the refusing path instead of throwing on it.
        // Normalized in one place, so the identity below is the same string the presence test judged — and so each half of
        // this test has a single, nameable site a falsifier can aim at.
        const command = typeof answer.command === 'string' ? answer.command.trim() : '';
        const observed = typeof answer.observed === 'string' ? answer.observed.trim() : '';
        if (command === '' || observed === '') continue;
        // **The command *is* the question.** A probe's identity is the command it asks, so two answers to one command are
        // one reading however they were recorded — the answer type carries no kind or path, and inventing one from the
        // stored probe list would make the count depend on a lookup that can be absent.
        const identity = command;
        if (askedQuestion.has(identity)) continue;
        askedQuestion.add(identity);
        verified += 1;
    }
    return verified;
}

/**
 * **One place that assembles a claim's decision, and the reason this module owns it.**
 *
 * `evaluateClaim` needs six inputs, and five consumers — the ladder's open-problem list, its closure verdict, the change
 * record, the archive gate and the review request — each built that input themselves. They agreed only because they copied
 * the same six lines; a sixth consumer that got one of them wrong would have produced a second answer to "is this claim
 * supported", which is the defect class (`one-concept-several-derivations`) this line has spent the most rounds on. Found
 * by looking for the class rather than for an instance: the count of `evaluateClaim(` call sites outside the kernel was
 * five.
 */
export type ClaimDecision = ClaimEvaluation & { severity: Severity; statement: string };

/**
 * The quorum, assembled from independent readings — or absent when the tier asks for none.
 *
 * Kept here rather than inline because two facts have to be decided together: whether the tier's reviewer count
 * requires a report at all, and which readings count as independent. A report is produced whenever the tier asks for
 * more than one reviewer, even from zero readings, so "nobody submitted" is a *count of zero* rather than a missing
 * field — the difference between a failed quorum and no quorum question asked.
 */
function chainQuorum(input: {
    records: QuorumRecord[];
    unattributed: number;
    evidenceToClaim: Record<string, string>;
    requiredReviewers: number;
    demandDiversity: boolean;
}): QuorumReport | undefined {
    if (input.records.length === 0 && input.requiredReviewers <= 1) return undefined;
    const outcome = aggregateQuorum({
        records: input.records,
        evidenceToClaim: input.evidenceToClaim,
        requiredReviewers: input.requiredReviewers,
        demandDiversity: input.demandDiversity,
        unattributed: input.unattributed,
    });
    return {
        disputedClaimIds: outcome.disputedClaimIds,
        undiversified: outcome.undiversified,
        reviewers: outcome.reviewers,
        requiredReviewers: input.requiredReviewers,
        unattributed: outcome.unattributed,
        // Passed through rather than invented here: the caller computed them from the repository's own state.
        reachedNewRiskClass: outcome.reachedNewRiskClass,
        unclassifiedTier: outcome.unclassifiedTier,
    };
}

/** Every claim's decision, from the ledger, with the input assembled once. */
export function claimDecisions(ledger: Ledger): ClaimDecision[] {
    return ledger.claims.map((claim) => ({
        ...evaluateClaim(claim, {
            evidence: ledger.evidence,
            verdicts: ledger.verdicts,
            reusedEvidence: new Set(),
            policy: ledger.policy,
            challenges: ledger.challenges,
            subjectRevision: ledger.subject?.revision ?? '',
        }),
        severity: claim.severity,
        statement: claim.statement,
    }));
}

/** The claims nothing supports and nobody waived: the one answer every consumer of "what is still open" needs. */
export function unsupportedClaims(ledger: Ledger): ClaimDecision[] {
    return claimDecisions(ledger).filter((decision) => decision.state !== 'supported' && decision.state !== 'waived');
}

export type LedgerVerdict =
    | { kind: 'absent'; detail: string }
    | { kind: 'unreadable'; detail: string }
    | { kind: 'decided'; tier: TierName; claims: number; assurance: AssuranceLevel; subjectRevision: string; decision: Decision };

/**
 * **Can this ledger be read as a decision?** — a pure question about a ledger, so the two surfaces that ask it cannot
 * answer differently.
 *
 * It was answered in two places: this one, and a re-derivation inside `openLedgerProblems` that tested
 * `malformedFiles || policyRejected` and stopped there — missing "claims without a frozen subject", which decides nothing
 * either. Measured with `subject.json` removed: the problems reader said `read` and published the claims while the verdict
 * said `unreadable`, so `navigation.ts` refused the closure while the approval, the archive gate and the repair entry all
 * read a count. Owning the predicate here means both surfaces ask one function of the ledger in their hand.
 *
 * `null` means readable. `absent` is reported separately because it is not a fault: a ledger nobody wrote is a normal
 * state, while a ledger that cannot be read is somebody's mistake, and only the first may be treated as "nothing to
 * decide".
 */
export function ledgerReadability(ledger: {
    malformedFiles: readonly string[];
    policyRejected: string | null;
    claims: readonly unknown[];
    subject: unknown;
    recordedFiles: readonly string[];
}): { kind: 'unreadable'; detail: string } | { kind: 'absent'; detail: string } | null {
    if (ledger.malformedFiles.length > 0) {
        // A file that exists and cannot be parsed decides nothing, and it must not read as "nothing recorded": the two are
        // different facts, and only one of them is somebody's mistake.
        return { kind: 'unreadable', detail: `the ledger holds ${ledger.malformedFiles.join(', ')}, which cannot be parsed, so it decides nothing` };
    }
    if (ledger.policyRejected !== null) {
        // The rule that would have been applied is not the one on disk, so the decision would be about a policy nobody wrote.
        return { kind: 'unreadable', detail: `the stored policy was refused (${ledger.policyRejected}), so nothing here decides` };
    }
    if (ledger.claims.length === 0) {
        return {
            kind: 'absent',
            detail: ledger.recordedFiles.length === 0
                ? 'no ledger has been recorded for this change, so nothing here decides it'
                : `the ledger holds ${ledger.recordedFiles.join(', ')} but no claims, so there is nothing to decide`,
        };
    }
    if (!ledger.subject) {
        return { kind: 'unreadable', detail: 'the ledger holds claims but no frozen subject, so no verdict can be about anything' };
    }
    return null;
}

export async function ledgerVerdict(input: {
    root: string;
    changeId: string;
    /** The recorded baseline, so a `0.6*C0` budget can be resolved. `null` leaves it unknown rather than satisfied. */
    c0Tokens?: number | null;
    /** An explicit tier overrides the classification; the classification is what a caller normally wants. */
    tier?: TierName;
    /** An explicit assurance override, for the case where the operator knows what the round's provenance was. */
    assurance?: AssuranceLevel;
    /**
     * The party asking for this decision, when it is known.
     *
     * Recorded so the decision can refuse an approval made by one of the parties that produced the evidence. That is the
     * one independence property a single-machine ledger can check: it cannot prove a context was fresh, but it can see
     * that the same actor wrote the claim, verified it, and approved it.
     */
    actor?: string;
    /**
     * The caller's own read of this ledger, when it already has one.
     *
     * **One decision, one read.** `readUpstreamSummary` asks this and `openLedgerProblems` for the same change, and each
     * opened ten ledger files — measured by an independent reading that wrapped `readFile` and counted two reads of
     * `claims.json`, `evidence.json`, `verdicts.json` and the rest per summary. The pointer got a handed-down read in an
     * earlier round; the ledger did not. A caller that has read the ledger passes it here, and the answer is computed from
     * those bytes.
     */
    ledger?: Ledger;
}): Promise<LedgerVerdict> {
    let ledger;
    if (input.ledger !== undefined) {
        ledger = input.ledger;
    } else {
        try {
            ledger = await readLedger(input.root, input.changeId);
        } catch (error) {
            return { kind: 'unreadable', detail: `the ledger could not be read: ${(error as Error).message}` };
        }
    }

    const readability = ledgerReadability(ledger);
    if (readability !== null) return readability;
    if (!ledger.subject) {
        // **Unreachable by construction, and asserted rather than assumed.** `ledgerReadability` refuses exactly this
        // state, so reaching here means the predicate and this narrowing disagree — which is the split this file removed.
        // Failing loudly is how the next edit that drops the condition is caught here instead of reading `undefined`.
        throw new Error('the ledger passed readability without a frozen subject, which is the state readability refuses');
    }

    // The quorum is assembled from the runs, compared over evidence rather than counted as votes; a single producer is not
    // a quorum and gets no report at all rather than a report claiming agreement.
    const producers = [...new Set(ledger.runs.map((run) => run.producer))];
    const evidenceToClaim: Record<string, string> = {};
    for (const claim of ledger.claims) for (const evidenceId of claim.evidenceIds) evidenceToClaim[evidenceId] = claim.id;
    // **The ceiling, applied at the boundary rather than left to the classification.** A floor is only as good as its
    // patterns, and the classification reads paths; a change to what evidence is accepted can sit under a pattern no rule
    // names. So the ledger route never decides below the policy's declared floor — an explicit `--tier` still wins,
    // because an operator who names a tier is making the decision this bound exists to keep honest.
    const classification = classifyRisk({
        paths: await declaredPaths(input.root, input.changeId),
        policy: ledger.policy,
    });
    // One derivation for the tier, shared with `ledger plan`: the ceiling is a rule about the tier, and a command that
    // ignored it reported a weaker tier than the one being enforced.
    const tier: TierName = resolveTier({ classification, policy: ledger.policy, ...(input.tier === undefined ? {} : { override: input.tier }) });
    // **The quorum is assembled from independent readings, not from reviewer names.** `groupByProducer` groups verdicts by
    // the run that decided them, so two runs are two observations and one run reported twice is one. The old shape handed
    // every producer the ledger's whole verdict list, which made `disputed` unreachable (one verdict per item) and made
    // `reviewers` a count of names rather than of readings — so `security.reviewers: 2` was unenforceable.
    const requiredReviewers = ledger.policy.tiers[tier].reviewers;
    // **Old verdicts are one reading, not one each.** A ledger written before `producer` existed groups every verdict under
    // one unattributed run: counting them individually would make a single run's readings look like a quorum, and the
    // count is reported so a shortfall caused by missing provenance is distinguishable from one caused by one reviewer.
    // **Every reading, not the projection** — and only the readings that speak for the revision being decided. The
    // projection is one entry per item, so reading it here is how a second reviewer became invisible; handing over *every*
    // reading is how a reading this ledger calls `stale` became a reviewer, measured by an independent review on a real
    // flow. `readingsForRevision` is the kernel's one derivation of that region, so the quorum and the projection cannot
    // answer "which readings are about this revision" differently.
    const { records, unattributed } = groupByProducer(readingsForRevision(ledger.readings, ledger.subject?.revision ?? null));
    const quorum: QuorumReport | undefined = chainQuorum({
        records,
        unattributed,
        evidenceToClaim,
        requiredReviewers,
        demandDiversity: ledger.policy.diversity.requiredOn.includes('quorum'),
    });

    const decision = decide({
        subject: ledger.subject,
        claims: ledger.claims,
        evidence: ledger.evidence,
        verdicts: ledger.verdicts,
        // **The identity question is asked of every reading.** Which reading survives is freshness; who took part is not,
        // and a displaced reading is still a reading its actor produced.
        allReadings: ledger.readings,
        challenges: ledger.challenges,
        policy: ledger.policy,
        tier,
        // The tier's contract, not the union of what the claims happen to say: a set derived from the claims makes the
        // coverage check unfailable, which is the one thing a gate must never be. The touched set comes from the path
        // table for the same reason — it is what the change reaches, not what its author asserted about it.
        declaredRiskClasses: ledger.policy.tiers[tier].requiredRiskClasses,
        touchedRiskClasses: classification.riskClasses,
        riskClassSources: classification.riskClassSources,
        assurance: input.assurance ?? (ledger.assurance as AssuranceLevel),
        usage: ledger.usage,
        c0Tokens: input.c0Tokens ?? null,
        // **Discovery counts what was observed, not what was declared.** A terminal challenge contributes only after its
        // check persisted a non-blank observation, and a probe answer only when it records a command and what that command
        // printed. Neither half proves the measurement was meaningful — what is deliberately *not* checked is written down
        // beside the derivation — and `reproduced` remains counterexample history, not a requirement that the current
        // revision still fail.
        discovery: {
            independentChallenges:
                // **Terminal, not "anything that is not open".** The negation counted a record whose `state` is missing or
                // not a member of the union, which made `independentChallenges` non-zero for a ledger that holds no
                // challenge at all — and the refusal then said `discovery_unverified` ("run the recorded challenge") when
                // the true remedy is `discovery_floor` ("record one"). Both refuse, but a refusal that names the wrong
                // step is the defect this whole criterion exists to remove.
                ledger.challenges.filter((challenge) => challenge.state === 'withdrawn' || challenge.state === 'resolved').length
                + (await readProbeAnswers(input.root, input.changeId)).length,
            verifiedChallenges:
                verifiedChallengeCount(ledger.challenges, await readProbeAnswers(input.root, input.changeId)),
        },
        ...(quorum === undefined ? {} : { quorum }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
    });

    return {
        kind: 'decided',
        tier,
        claims: ledger.claims.length,
        assurance: input.assurance ?? (ledger.assurance as AssuranceLevel),
        subjectRevision: ledger.subject.revision,
        decision,
    };
}

/**
 * The ledger's open problems: claims that are neither supported nor waived, with the severity the tier contract gave them.
 *
 * **It lives beside `unsupportedClaims` because that is what it is**: a projection of the same decision, and the module
 * that owns the decision is the one that can promise every reader gets the same answer. It used to live in
 * `workflow/navigation.ts`, which meant the review gate and the repair entry imported a *router* to read the ledger — a
 * quality gate depending on the thing that decides where to go next. One derivation, in the module that derives it.
 *
 * **An unreadable ledger is a refusal, not a crash** (`kind: 'unreadable'`). It used to throw, and two call sites —
 * `cmdVerify` and `cmdJudge` — call it bare, so a malformed `claims.json` turned those commands into stack traces while
 * the same call behind `review-read.ts` was already being wrapped and reported. A reader whose two callers disagree about
 * how to fail is the defect this change exists to remove, so the failure is a value here too and every caller decides
 * with it.
 */
export type LedgerProblemsRead =
    | { kind: 'read'; problems: Array<{ id: string; severity: string; statement: string }> }
    | { kind: 'unreadable'; detail: string };

// **The projection with no consumer is gone.** `openProblemsForReport` mapped the read to a `{problems, unreadable}`
// pair that only its own test used, while the envelope shape both commands publish comes from `openProblemsReportFields`
// below. Two producers for one shape is how the surfaces drift, and this file deletes that pattern everywhere else.
/**
 * The fields a command envelope publishes for the ledger read: the count, or the reason there is no count.
 *
 * **Spread from one function, because it was copied onto two surfaces and only one copy was asserted.** Measured:
 * restoring an unconditional `openProblems` on the judge path left the whole suite green, so the two report surfaces could
 * disagree about whether a `0` means "no problems" or "nobody looked" without any case noticing. The invariant is one
 * line of shape — *`openProblems` and `openProblemsUnreadable` are never both present* — and it is now produced in one
 * place, so the two commands cannot drift.
 */
export function openProblemsReportFields(read: LedgerProblemsRead): { openProblems?: number; openProblemsUnreadable?: string } {
    return read.kind === 'read' ? { openProblems: read.problems.length } : { openProblemsUnreadable: read.detail };
}

/**
 * The problems a ledger holds, **or the verdict's own reason for refusing it.**
 *
 * **This used to re-derive the readability predicate, and the two answers had already diverged.** The reader tested
 * `malformedFiles.length > 0 || policyRejected !== null`; `ledgerVerdict` tests the same two facts *and* a third — a
 * ledger that holds claims but no frozen subject decides nothing either. Measured on one fixture with `subject.json`
 * removed: this reader answered `read` (and published the claims as problems) while `ledgerVerdict` answered `unreadable`
 * — so `navigation.ts` refused the closure and routed to a repair while `readBlockingProblems`, which the approval, the
 * archive gate and the repair entry all share, published the counts. One file, two answers, in the module whose own
 * heading says "One derivation, in the module that derives it".
 *
 * So the predicate is not restated here: `unreadable` and `absent` are the verdict's answers, and this reader asks for
 * them. The only thing it owns is the mapping from "the ledger decides nothing" to the problems list.
 */
export async function openLedgerProblems(root: string, changeId: string, ledgerInHand?: Ledger): Promise<LedgerProblemsRead> {
    // **One read, and the readability answer asked of that same ledger.**
    //
    // Three versions of this function got it wrong in three different ways, and the third is the one that matters: after
    // delegating the *decision* to the verdict, it still asked the verdict first (one read) and then read the ledger again
    // to count — so when the second read failed, this surface published `openProblems: 0` for a ledger the verdict had
    // just refused, which is the `0` meaning "no problems" that this whole family of fixes exists to remove. Measured: two
    // reads per call. Asking one pure function of a ledger already in hand makes the two answers agree by construction and
    // the count come from the same bytes the refusal was computed from.
    const ledger = ledgerInHand ?? (await readLedger(root, changeId));
    const readability = ledgerReadability(ledger);
    if (readability?.kind === 'unreadable') return { kind: 'unreadable', detail: readability.detail };
    // `absent` is readable: a ledger nobody wrote lists no problems, and that is a fact rather than a refusal.
    return {
        kind: 'read',
        problems: unsupportedClaims(ledger).map((claim) => ({ id: claim.claimId, severity: claim.severity, statement: claim.statement })),
    };
}
