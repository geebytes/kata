/**
 * The severity ladder: which severities refuse approval under which review mode, and what "open" means — nothing else.
 *
 * **It lives in `quality/`, not in `workflow/`.** It is a policy about findings, and two consumers are quality modules
 * (`acceptance-matrix` asks it whether a tier requires a declared matrix; the repair record asks it what a round was
 * opened for). While it lived under `workflow/`, every one of them had to import *upwards* — which is how the review gate
 * came to depend on `navigation.ts`, a router — or spell the rule a second time, which is how the rule came to have three
 * homes in the first place.
 *
 * The history it replaces: `"blocking, plus major in strict"` was written out in `repair-entry.authorizeReviewRepair`, in
 * `navigation.suggestCandidateAction` and in `distill-gates.evaluateReviewClearance`, each comparing the mode against the
 * literal `'strict'`. The three had already drifted — the gate did not read the mode at all — and the literal made the
 * `security` tier, whose kernel policy asks for two reviewers, always-on quorum and a sandboxed assurance floor, block on
 * *less* than the tier below it.
 */

/**
 * Whether a recorded finding is still open — the schema's own rule, kept in one place.
 *
 * `schemas/review-finding.schema.json` says "Absent means open", and a finding disposed `fixed`, `deferred`, `accepted` or
 * `routed` is not a problem any more. Reading `disposition` only in some consumers is how a problem that was disposed of
 * keeps refusing a gate, keeps authorising a repair, and keeps being named in a refusal — one lifecycle field, several
 * readers, the class this module exists to remove.
 */
export function isOpenFinding(finding: { disposition?: string }): boolean {
    // **Only `fixed` closes a finding.** `deferred`, `accepted` and `routed` all mean "this problem is still here": it
    // was not repaired in this change. The first version of this predicate closed all three, which made the gate *weaker*
    // than the code it replaced and than `change-record.ts`, whose `openFindings` filter is `disposition !== 'fixed'` and
    // whose test says so in as many words ("a routed one still is — it left this change, it was not repaired here"). One
    // lifecycle field, two readers, two opposite readings is the class this work exists to remove.
    return finding.disposition !== 'fixed';
}

export type MergeBlockingProblem = {
    source: 'finding' | 'claim';
    id: string;
    severity: string;
    message: string;
};

/**
 * The kernel's name for a workflow review mode.
 *
 * `workflowProfile.reviewMode` says `std`, the kernel's tier table says `standard`. Two spellings of one concept, and
 * until this mapping existed nobody owned the translation. An absent mode is a task opened before the profile existed;
 * those were held to the std ladder, and a mode nobody can name is not quietly made the strictest one, because that
 * would newly refuse work no rule ever refused.
 */
export function reviewTierFor(mode: string | undefined): 'standard' | 'strict' | 'security' {
    const named = mode?.trim().toLowerCase();
    // Absent is legacy: a task opened before the profile existed was held to the std ladder, and so is one whose profile
    // says nothing. `standard` is accepted as well as `std`, because both spellings name this tier and the translation
    // has to have a home somewhere.
    if (named === undefined || named === '' || named === 'std' || named === 'standard') return 'standard';
    if (named === 'strict') return 'strict';
    if (named === 'security') return 'security';
    // **A mode this repository cannot name fails closed.** Returning the weakest ladder for `'securty'` — a hand-written
    // profile, since the schema enums the field — would silently drop the strongest tier to the weakest, which is the
    // fail-open direction. The spelling is normalized above; a value nobody can name is treated as the strictest one, and
    // the surfaces that print the mode still print what was written, so the typo stays visible.
    return 'security';
}

/**
 * The severities a mode refuses approval for — **ordered hardest first**. The one home.
 *
 * The order is part of the contract, not an accident of how the array was typed: a reader that wants to tell "this
 * problem blocks everywhere" from "this problem blocks only above std" reads position 0, so the ordering cannot drift
 * without the ladder saying so.
 */
export function mergeBlockingSeverities(mode: string | undefined): readonly string[] {
    return reviewTierFor(mode) === 'standard' ? ['blocking'] : ['blocking', 'major'];
}

export function isMergeBlocking(mode: string | undefined, severity: string | undefined): boolean {
    return severity !== undefined && mergeBlockingSeverities(mode).includes(severity);
}

/**
 * The open problems that refuse approval, from every source that can carry one.
 *
 * Two sources, asked once. `findings` is the review record's own list — it has no producer on the current route, but a
 * record written before that route was retired may still carry them, and the approval round-trips what it reads.
 * `claims` is the ledger's open problems, which is where a problem is recorded now. A reader that asked only one of
 * them would be the same defect in a new place: `distill-gates` refused on findings while the approval rested on the
 * ledger, so the two surfaces answered different questions about the same change.
 */
export function openProblemsOf(input: {
    findings?: ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string }>;
    claims?: ReadonlyArray<{ id: string; severity: string; statement: string }>;
}): MergeBlockingProblem[] {
    const problems: MergeBlockingProblem[] = [];
    for (const finding of input.findings ?? []) {
        if (!isOpenFinding(finding)) continue;
        problems.push({ source: 'finding', id: finding.id ?? '(unnamed finding)', severity: finding.severity ?? '', message: finding.message ?? '' });
    }
    // A ledger claim arrives here only when it is neither supported nor waived — `openLedgerProblems` is that decision —
    // so openness is asked once per source, in the source that owns it.
    for (const claim of input.claims ?? []) {
        problems.push({ source: 'claim', id: claim.id, severity: claim.severity, message: claim.statement });
    }
    return problems;
}

/**
 * The subset of a set of open problems that this mode refuses approval for.
 *
 * Kept apart from `openProblemsOf` because the two answer different questions: a *report* counts everything open, a
 * *decision* refuses on the mode's bar. Deriving the report by asking the decision (with no mode) silently dropped every
 * `major` problem from the counts, because "no mode" reads as the std ladder.
 */
export function mergeBlockingProblems(input: {
    mode: string | undefined;
    findings?: ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string }>;
    claims?: ReadonlyArray<{ id: string; severity: string; statement: string }>;
}): MergeBlockingProblem[] {
    return openProblemsOf(input).filter((problem) => isMergeBlocking(input.mode, problem.severity));
}

/**
 * How many findings carry each of the two severities a mode can block on.
 *
 * A **report**, not a decision: the fields exist so `status` can say what the recorded review holds, and they are
 * named after severities rather than after "blocking", so the names are intrinsic here and the ladder stays the only
 * place a blocking question is answered.
 */
export function countFindingsBySeverity(problems: ReadonlyArray<{ severity: string }>): { blocking: number; major: number } {
    const counts = { blocking: 0, major: 0 };
    for (const problem of problems) {
        if (problem.severity === 'blocking') counts.blocking += 1;
        else if (problem.severity === 'major') counts.major += 1;
    }
    return counts;
}

/**
 * The refusal sentence for the problems a mode blocks on, or an empty string when there are none.
 *
 * **Why this is a function and not a line of prose in the caller.** The approval used to refuse with the ledger's reason
 * codes alone, which say *that* the ledger does not pass and leave the reader to reconstruct which of those reasons the
 * current mode's bar is about — the mode's severity rule lived nowhere a person could read it. The sentence names each
 * problem by id and severity and states the bar it was measured against, and it is derived from the same ladder the three
 * routers read, so the refusal and the routing cannot disagree about what blocks.
 */
export function describeBlockingProblems(mode: string | undefined, problems: readonly MergeBlockingProblem[]): string {
    if (problems.length === 0) return '';
    const issues = problems.map((problem) => `${problem.id} (${problem.severity}): ${problem.message}`);
    return `At the ${reviewTierFor(mode)} bar (${mergeBlockingSeverities(mode).join(', ')}), `
        + `${problems.length} problem(s) are open: ${issues.join(' | ')}`;
}
