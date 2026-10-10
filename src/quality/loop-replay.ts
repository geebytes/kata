import { isDefectClass, oracleFor, type DefectClass } from './defect-classes.js';
import { classRecurrence, type ReviewRound } from './repair.js';

/**
 * **What the recorded loop actually looked like: which classes it paid for, and how much of it a machine could have decided.**
 *
 * This is the report the change exists for, computed from the round records rather than from prose. It answers the questions
 * the store could not answer before the round record carried its findings (102 rounds, 56 findings, `review.json` overwritten
 * each round):
 *
 * - **How much of the loop is mechanizable at all.** The share of rounds whose findings were all in classes a machine can
 *   decide is the upper bound on what generators could have taken off the independent rounds, and `judgmentShare` is the part
 *   independent rounds must keep doing — reporting both is what keeps the mechanism from claiming it replaces inspection.
 * - **How much of it is recycling.** `repairOriginShare` is the share of findings that were defects in a *previous* round's
 *   repair. That is the number that says whether the loop is converging or churning, and it is invisible to a count of
 *   blocking findings (which can be flat for both).
 * - **The discovery rate, only when it is identifiable.** A rate fitted to a handful of rounds is a number with no meaning, so
 *   below `IDENTIFIABLE_ROUNDS` the report says `identified: false` and gives the reason instead of a figure — a fabricated
 *   parameter would be read as evidence for a stopping rule nobody could justify.
 *
 * Nothing here decides anything: it is the measurement the *next* decision (whether a generator per class pays for itself) is
 * made from, and it is deliberately computed from records only — no free-text inference, so a second reader gets the same
 * numbers from the same store.
 */
export interface LoopReplay {
    rounds: number;
    findings: number;
    /** Findings that carry a class, which is the set every share below is computed over. */
    classified: number;
    /** Share of rounds whose findings were all in classes whose oracle is `mechanizable`. */
    mechanizableRoundShare: number;
    /** Share of classified findings that were defects in a previous round's repair. */
    repairOriginShare: number;
    /** Share of classified findings whose class needs a judgment — the part no generator can take over. */
    judgmentShare: number;
    /** The classes that came back inside a repair: the stop-line signal this loop is measured by. */
    stopLineCandidates: string[];
    discovery:
        | { identified: false; reason: string }
        | { identified: true; findingsPerRound: number | null; /** `null` when no recorded round had a numeric count: a rate over an empty set is not zero, it is unmeasured. */ blockingPerRound: number | null; roundsForHalfRate: number | null };
    /** Rows that could not contribute, named — a legacy row with no findings is not a row with none. */
    unavailable: string[];
    /** Rounds whose blocking count was recorded as "could not be measured" (`null`), named: they are not rounds with zero. */
    unmeasuredRounds: string[];
}

/** Below this many rounds a per-round rate is not identifiable, and reporting one would be a number without a meaning. */
export const IDENTIFIABLE_ROUNDS = 12;

export function replayLoop(rounds: readonly ReviewRound[]): LoopReplay {
    const unavailable = rounds.filter((round) => (round.findings ?? []).length === 0 && round.noFindings === undefined).map((round) => round.at);
    // **`null` is "could not be measured", and averaging it as `0` is the reading this repository's own records distinguish.**
    // The round row was given the two states on purpose (`0` cleared, `null` nothing to measure); a rate that folds them
    // together reports a loop that measured nothing as a loop that found nothing (measured by an independent round).
    const unmeasuredRounds = rounds.filter((round) => round.blockingCount === null).map((round) => round.at);
    const measuredBlocking = rounds.filter((round) => typeof round.blockingCount === 'number');
    const withFindings = rounds.filter((round) => (round.findings ?? []).length > 0);
    const findings = withFindings.flatMap((round) => round.findings ?? []);
    const classified = findings.filter((finding): finding is typeof finding & { class: DefectClass } => isDefectClass(finding.class));

    const mechanizableRounds = withFindings.filter((round) =>
        (round.findings ?? []).every((finding) => isDefectClass(finding.class) && oracleFor(finding.class) === 'mechanizable'),
    );
    const repairOrigin = classified.filter((finding) => finding.origin === 'repair');
    // No cast to `never` here: the repository refuses those, and the narrowing is what carries the type anyway.
    const judgment = classified.filter((finding): finding is typeof finding & { class: DefectClass } => isDefectClass(finding.class) && oracleFor(finding.class) === 'judgment');

    const share = (part: number, whole: number): number => (whole === 0 ? 0 : Number((part / whole).toFixed(4)));

    return {
        rounds: rounds.length,
        findings: findings.length,
        classified: classified.length,
        mechanizableRoundShare: share(mechanizableRounds.length, withFindings.length),
        repairOriginShare: share(repairOrigin.length, classified.length),
        judgmentShare: share(judgment.length, classified.length),
        stopLineCandidates: classRecurrence(rounds).filter((entry) => entry.stopLineCandidate).map((entry) => entry.class),
        discovery:
            rounds.length < IDENTIFIABLE_ROUNDS
                ? {
                    identified: false,
                    reason: `${rounds.length} round(s) recorded: a per-round discovery rate is not identifiable below ${IDENTIFIABLE_ROUNDS}, and a figure fitted to fewer would read as evidence for a stopping rule nobody could justify — the observed series is in the records themselves`,
                }
                : {
                    identified: true,
                    // The denominator is the rounds whose findings could be **read**: an unreadable row is named in
                    // `unavailable` and cannot stand in for a round that found nothing (R3-F3, measured by an independent
                    // round — the R2-F4 repair closed this fold for the blocking rate only).
                    findingsPerRound: rounds.length - unavailable.length === 0 ? null : share(findings.length, rounds.length - unavailable.length),
                    blockingPerRound: measuredBlocking.length === 0
                        // **An empty measured set is not a zero rate.** `share` answers `0` for a `0/0` denominator, so a
                        // history where nothing could be measured reported the same number as a history that measured
                        // zero blocking findings — the fold R1-F3 closed for the mixed case, still open for this one.
                        ? null
                        : share(measuredBlocking.reduce((total, round) => total + (round.blockingCount as number), 0), measuredBlocking.length),
                    // The rounds it would take for the observed rate to halve if it decays at the rate it has shown so far:
                    // a statement about the *series*, not a prediction, and stated as such in the report.
                    // **`0` here reads as "stop now".** With no findings there is nothing to halve, so the honest value is
                    // `null` rather than the smallest number the type allows (R3-F3).
                    roundsForHalfRate: findings.length === 0 ? null : Math.ceil(Math.log(0.5) / Math.log(1 - share(findings.length, rounds.length) / Math.max(findings.length, 1))),
                },
        unavailable,
        unmeasuredRounds,
    };
}
