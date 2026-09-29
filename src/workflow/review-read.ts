import { readFile } from 'node:fs/promises';
import { readValidatedOptional } from '../core/schema.js';
import { openLedgerProblems } from '../store/verdict.js';
import { bindsToRevision, currentRevisionIdentity } from './verdict-binding.js';
import { reviewPath as layoutReviewPath, taskPath } from '../core/layout.js';
import type { ReviewFinding } from '../quality/reviewer.js';
import { isMergeBlocking, openProblemsOf, type MergeBlockingProblem } from '../quality/review-ladder.js';

/**
 * The recorded review artefact: status, revision binding, the approval's evidence summary and the findings. It lives
 * here rather than in the orchestrator because the gate and the router also read it, and a quality module importing the
 * workflow orchestrator would invert the layering.
 *
 * **Its failures are silent on purpose, and that is why the gates do not use it.** `readReview` answers "what does the
 * record say", which for a record that cannot be parsed is the same as for one that says nothing. A surface that has to
 * *decide* asks `readReviewRecord` instead, which refuses rather than guessing.
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

export async function readReviewMode(root: string, taskId: string): Promise<string | undefined> {
    try {
        const raw = await readFile(taskPath(root, taskId), 'utf8');
        const parsed = JSON.parse(raw) as { workflowProfile?: { reviewMode?: string } };
        return parsed.workflowProfile?.reviewMode;
    } catch {
        return undefined;
    }
}

/**
 * The recorded review, read the way a gate has to read it: absent, usable, or **refused**.
 *
 * The two readers that existed here each decided this differently. `readReview` swallowed every failure and returned an
 * empty findings list, so a record that could not be parsed was indistinguishable from one that said nothing — which is
 * how "the file is unreadable" came to look exactly like "nothing was found". `readValidatedOptional`, used directly by
 * the gate, throws instead, so a malformed record turned a *denial* into an exception escaping the command. A gate must
 * answer; it must not crash and it must not guess.
 */
export type ReviewRecordRead =
    | {
        ok: true;
        findings: ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string }>;
        /**
         * Whether the record describes the change as it stands.
         *
         * A record written against other content is not evidence about this one, so its findings do not count — the rule
         * the router already applied (`onlyCurrentRevision`) and that the first version of this reader dropped, which made
         * a stale record's findings refuse a gate.
         */
        boundToCurrentRevision: boolean;
        /** The parsed record, for the fields this reader does not name: status, evidence, route, binding. */
        record: Record<string, unknown>;
    }
    | { ok: false; why: string };

export async function readReviewRecord(root: string, taskId: string): Promise<ReviewRecordRead> {
    let record: ({ findings?: unknown } & Record<string, unknown>) | null;
    try {
        record = await readValidatedOptional<{ findings?: unknown } & Record<string, unknown>>('review', layoutReviewPath(root, taskId));
    } catch (error) {
        return {
            ok: false,
            why: `the recorded review is not the shape its schema declares, so nothing can be decided from it (${(error as Error).message})`,
        };
    }
    if (!record) return { ok: true, findings: [], boundToCurrentRevision: true, record: {} };
    if (record.findings !== undefined && !Array.isArray(record.findings)) {
        return { ok: false, why: 'the recorded review carries a `findings` field that is not a list' };
    }
    const identity = await currentRevisionIdentity(root, taskId);
    return {
        ok: true,
        findings: (record.findings ?? []) as ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string }>,
        boundToCurrentRevision: bindsToRevision(record as never, identity),
        record: record as Record<string, unknown>,
    };
}

/**
 * **The blocking question, asked once.** Every consumer that refuses, routes or authorises calls this and none of them
 * assembles the inputs itself.
 *
 * That is the fix for the defect an independent review measured: the approval passed `{mode, claims}` while the distill
 * gate passed `{mode, findings, claims}`, so one change could be *approved*, routed to the judge, and *authorised for
 * repair* while the gate that guards the archive refused it (`tmp/repro-c3c4.mts`). Three answers to one question, and the
 * cause was not the ladder — it was that each caller built the question its own way. A reader that owns the inputs makes
 * that unrepresentable: there is no call site left to get them wrong.
 */
export type BlockingProblemsRead =
    | {
        ok: true;
        mode: string | undefined;
        /** Every open problem, whatever its severity: what a *report* counts. */
        openProblems: MergeBlockingProblem[];
        /** The subset at this mode's bar: what a *decision* refuses on. */
        problems: MergeBlockingProblem[];
    }
    | { ok: false; why: string };

export async function readBlockingProblems(root: string, taskId: string): Promise<BlockingProblemsRead> {
    const mode = await readReviewMode(root, taskId);
    const record = await readReviewRecord(root, taskId);
    if (!record.ok) return { ok: false, why: record.why };
    const claims = await openLedgerProblems(root, taskId);
    // One read, two readings: the report counts every open problem, the decision refuses on the ones this mode's ladder
    // names. A record that does not describe the current content contributes no findings — those were about other content.
    const findings = record.boundToCurrentRevision ? record.findings : [];
    const openProblems = openProblemsOf({ findings, claims });
    return { ok: true, mode, openProblems, problems: openProblems.filter((problem) => isMergeBlocking(mode, problem.severity)) };
}
