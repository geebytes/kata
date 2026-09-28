import type { EvidenceVerdict } from '../kernel/types.js';
import { readLedger } from './ledger.js';
import { buildContext } from './verify-context.js';
import { createInlineAdapter } from '../assurance/adapters/inline-adapter.js';
import { CHECK_CANNOT_RUN, verifyAll } from '../producers/verifiers.js';
import type { EvidenceAdapter } from '../producers/port.js';

/**
 * **Replay: re-run the evidence and compare, writing nothing.**
 *
 * The acceptance item "≥95% of blocking/major evidence can be replayed by kata independently" was recorded as ✅ on the
 * strength of each evidence item carrying a `{before, mutated, after}` triple. That is the *record* of a measurement, not
 * the measurement — and the record's shape cannot tell you whether the measurement still holds, because the two things
 * that make it hold move: the artifact the check reads, and the mutation site the falsifier edits. A falsifier whose
 * mutation site is gone does not become false, it becomes unreadable — the verifier has a branch for exactly that.
 *
 * So the number needs an instrument, and this is it: every recorded evidence item is re-run through the same verifier the
 * original verdict came from, and the fresh verdict is compared with the recorded one. **Nothing is written** — the
 * verdicts are returned rather than recorded, which is the whole difference between this and `ledger evidence verify`
 * (that command records what it finds, and recording it into a ledger about a *previous* revision is not this command's
 * business).
 *
 * `replayRate` counts agreements over the items that were verified at the time. A recorded verdict that a replay cannot
 * reproduce means one of two things, and the report separates them rather than averaging them: `changed` is a disagreement
 * (the world differs from the record) and an `inconclusive` replay is a *decay* (the check can no longer be run — the
 * mutation site is gone), which is the failure mode a recorded triple is structurally blind to.
 */
export interface ReplayOutcome {
    evidenceId: string;
    evidenceType: string;
    /** The verdict on record, or `null` when the item was never verified. */
    recorded: string | null;
    replayed: EvidenceVerdict['verdict'];
    agrees: boolean;
    /** What the replay observed, so a disagreement can be read rather than guessed at. */
    observed: string;
}

export interface ReplayReport {
    changeId: string;
    subjectRevision: string;
    adapter: string;
    assurance: string;
    items: ReplayOutcome[];
    /** Items that had a verdict on record and were re-run: the denominator. */
    replayed: number;
    agrees: number;
    /** Disagreements, where the record and the world no longer say the same thing. */
    changed: ReplayOutcome[];
    /**
     * Items a replay could not *evaluate*, so the record is neither confirmed nor contradicted.
     *
     * Two shapes, and both are decay rather than a lie: a verdict that comes back `inconclusive` (the mutation site is
     * gone, the file it names is absent) and a check whose precondition no longer holds — the falsifier reports that as
     * `refuted`, because the *evidence item* is invalid either way, but the cause is that the command cannot run. The
     * first version of this split treated only `inconclusive` as decay and filed nine un-runnable checks as
     * disagreements, which reads as "the record was wrong" when the fact is "the record can no longer be checked".
     */
    decayed: ReplayOutcome[];
    neverVerified: string[];
    /** Agreements over the items that had a verdict. `null` when none did — a denominator nobody can fill is not a rate. */
    replayRate: number | null;
    /** What this instrument is not suitable for answering. */
    measures: string;
}

export async function replayEvidence(input: {
    root: string;
    changeId: string;
    /**
     * The route the replay executes on. There is one, and the parameter exists so a caller can say so rather than assume it.
     *
     * **A relayed replay would be the record comparing itself.** The file adapter's `verify` re-reads `${dir}/${id}.json` —
     * a result somebody recorded — so replaying through it can only report `agrees` (the file says what it says) or
     * `inconclusive` (the file is missing or was recorded against another revision). It measures file availability, not
     * whether the evidence still reproduces. The `--adapter file` switch this verb briefly offered promised a comparison it
     * could not make, which is the shape this repository removes most often: an option whose name overstates what it does.
     */
    route?: 'execute';
    /** The envelope a replayed command runs under. Defaults to two minutes, the standard tier's own wall clock. */
    timeoutMs?: number;
    now?: () => string;
}): Promise<ReplayReport | { refused: string }> {
    const ledger = await readLedger(input.root, input.changeId);
    if (ledger.subject === null) {
        return {
            refused: 'the subject is not frozen, so there is no revision the recorded verdicts are about and no way to replay them against one. Run `ledger freeze` first.',
        };
    }
    const adapter: EvidenceAdapter = createInlineAdapter();
    // **The same context the recording path used**, not a second one: containment, the wall clock and the producer
    // identity are exactly what a replay has to hold constant for its comparison to mean anything. A replay that
    // enforced a different envelope would be measuring a different thing than the verdict it compares against.
    const context = buildContext(input.root, ledger.subject, {
        timeoutMs: input.timeoutMs ?? 120_000,
        // A replay is not an authorship claim: it says what this process observed now, and the receipt question is a
        // different axis. Naming it as its own run keeps it from looking like a new verdict from the original producer.
        producer: { runId: `replay-${ledger.subject.revision}`, actor: 'replay' },
        ...(input.now === undefined ? {} : { now: input.now }),
    });
    const fresh = await verifyAll(ledger.evidence, context, (item, inner) => adapter.verify(item, inner));

    const byId = new Map(ledger.verdicts.map((verdict) => [verdict.evidenceId, verdict]));
    const items: ReplayOutcome[] = ledger.evidence.map((item, index) => {
        const recorded = byId.get(item.id) ?? null;
        const replayed = fresh[index]!;
        return {
            evidenceId: item.id,
            evidenceType: item.type,
            recorded: recorded?.verdict ?? null,
            replayed: replayed.verdict,
            agrees: recorded !== null && recorded.verdict === replayed.verdict,
            observed: replayed.observed,
        };
    });

    const withVerdict = items.filter((item) => item.recorded !== null);
    // The marker rather than the verdict: a check that cannot be evaluated and a check that does not redden both come back
    // `refuted`, and only one of them says anything about the claim.
    const cannotBeEvaluated = (item: ReplayOutcome): boolean => item.replayed === 'inconclusive' || item.observed.startsWith(CHECK_CANNOT_RUN);
    const decayed = withVerdict.filter((item) => !item.agrees && cannotBeEvaluated(item));
    const changed = withVerdict.filter((item) => !item.agrees && !cannotBeEvaluated(item));
    const agrees = withVerdict.length - changed.length - decayed.length;

    return {
        changeId: input.changeId,
        subjectRevision: ledger.subject.revision,
        adapter: adapter.id,
        assurance: adapter.assurance,
        items,
        replayed: withVerdict.length,
        agrees,
        changed,
        decayed,
        neverVerified: items.filter((item) => item.recorded === null).map((item) => item.evidenceId),
        replayRate: withVerdict.length === 0 ? null : agrees / withVerdict.length,
        measures:
            'whether the recorded verdicts can be reproduced now, per item — not whether they were right when recorded, and '
            + 'not whether the checks are adequate: a check that reproduces perfectly can still be the wrong check.',
    };
}
