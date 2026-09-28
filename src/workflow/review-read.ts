import { readFile } from 'node:fs/promises';
import { reviewPath as layoutReviewPath, taskPath } from '../core/layout.js';
import type { ReviewFinding } from '../quality/reviewer.js';

/**
 * The recorded review artefact: status, revision binding, the approval's evidence summary and the findings. It lives
 * here rather than in the orchestrator because the adversarial brief and the gate also read it, and a quality module
 * importing the workflow orchestrator would invert the layering.
 */
export async function readReview(root: string, taskId: string): Promise<{ revisionId?: string; status?: string; reviewEvidence?: string; findings: ReviewFinding[] }> {
    try {
        const reviewRaw = await readFile(layoutReviewPath(root, taskId), 'utf8');
        const reviewParsed = JSON.parse(reviewRaw) as { revisionId?: string; status?: string; reviewEvidence?: string; findings?: ReviewFinding[] };
        return { revisionId: reviewParsed.revisionId, status: reviewParsed.status, reviewEvidence: reviewParsed.reviewEvidence, findings: reviewParsed.findings ?? [] };
    } catch {
        return { findings: [] };
    }
}

/**
 * The severity ladder — which severities refuse approval under which review mode — and nothing else.
 *
 * It used to be written out three times (`repair-entry.authorizeReviewRepair`, `navigation.suggestCandidateAction`,
 * `distill-gates.evaluateReviewClearance`), and the three copies already disagreed: `distill-gates` compared a severity
 * without reading the mode, and all three tested the mode against the literal `'strict'`, so the `security` tier — the
 * one whose kernel policy asks for two reviewers, always-on quorum and a sandboxed assurance floor — blocked on *less*
 * than `strict`. One exported answer is what makes them unable to drift: a new copy is a failing test
 * (`tests/unit/review-severity-policy.test.ts`), not a review finding three rounds later.
 *
 * **The ladder names what blocks.** A severity outside it — `minor`, `note`, `nit`, or a value from a record this
 * repository cannot name — is not silently promoted to blocking. That is deliberate: promoting an unrecognised string
 * would refuse approvals no declared rule ever refused, and a severity vocabulary is a schema question, not a policy
 * question.
 */
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
    return mode === 'strict' || mode === 'security' ? mode : 'standard';
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
export function mergeBlockingProblems(input: {
    mode: string | undefined;
    findings?: ReadonlyArray<{ id?: string; severity?: string; message?: string }>;
    claims?: ReadonlyArray<{ id: string; severity: string; statement: string }>;
}): MergeBlockingProblem[] {
    const problems: MergeBlockingProblem[] = [];
    for (const finding of input.findings ?? []) {
        if (!isMergeBlocking(input.mode, finding.severity)) continue;
        problems.push({ source: 'finding', id: finding.id ?? '(unnamed finding)', severity: finding.severity ?? '', message: finding.message ?? '' });
    }
    for (const claim of input.claims ?? []) {
        if (!isMergeBlocking(input.mode, claim.severity)) continue;
        problems.push({ source: 'claim', id: claim.id, severity: claim.severity, message: claim.statement });
    }
    return problems;
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
 * The review mode the task declared, read once.
 *
 * The mode is the ladder's input, and it was being read inline in the gate, in the repair entry and in the
 * orchestrator — three reads of one fact, each free to miss a rename. The reader is not placed in `core/task.ts`
 * because the task record's own reader returns the whole record; this is the one field the ladder needs.
 *
 * A missing or unreadable task is reported as `undefined` rather than thrown: the ladder treats that as the std
 * ladder, which is what a task opened before the profile existed was held to.
 */
export async function readReviewMode(root: string, taskId: string): Promise<string | undefined> {
    try {
        const raw = await readFile(taskPath(root, taskId), 'utf8');
        const parsed = JSON.parse(raw) as { workflowProfile?: { reviewMode?: string } };
        return parsed.workflowProfile?.reviewMode;
    } catch {
        return undefined;
    }
}
