import { readFile } from 'node:fs/promises';
import { readValidatedOptional } from '../core/schema.js';
import { bindsToRevision, currentRevisionIdentity } from './verdict-binding.js';
import { reviewPath as layoutReviewPath, taskPath } from '../core/layout.js';
import type { ReviewFinding } from '../quality/reviewer.js';
import { mergeBlockingProblems, openProblemsOf, type MergeBlockingProblem } from '../quality/review-ladder.js';

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
        findings: ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string; acceptanceId?: string; path?: string }>;
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
    // **Inside the guard, because a gate input must not throw.** `currentRevisionIdentity` rethrows anything that is not
    // ENOENT, so a `current-revision.json` that is unreadable or is not JSON made this reader throw — and with it the
    // gate, the approval and the repair entry. The revision read is part of reading the record, so it belongs in the same
    // guard as the record read.
    let bound = false;
    try {
        bound = bindsToRevision(record as never, await currentRevisionIdentity(root, taskId));
    } catch (error) {
        return {
            ok: false,
            why: `the revision this change is bound to cannot be read, so nothing can be said about which content the review is about (${(error as Error).message})`,
        };
    }
    return {
        ok: true,
        findings: (record.findings ?? []) as ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string; acceptanceId?: string; path?: string }>,
        boundToCurrentRevision: bound,
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
        /** Whether a record exists at all. A missing record and an unreadable one need different repairs. */
        exists: boolean;
        /** Whether the record describes the content in hand: a consumer that acts on the record needs this. */
        boundToCurrentRevision: boolean;
        /** The record's own findings, already filtered by the binding above. */
        findings: ReadonlyArray<{ id?: string; severity?: string; message?: string; disposition?: string; acceptanceId?: string; path?: string }>;
        /** The parsed record, for the fields this reader does not name. */
        record: Record<string, unknown>;
    }
    | { ok: false; why: string };

export async function readBlockingProblems(root: string, taskId: string): Promise<BlockingProblemsRead> {
    const mode = await readReviewMode(root, taskId);
    const record = await readReviewRecord(root, taskId);
    if (!record.ok) return { ok: false, why: record.why };
    // **Imported here rather than at the top, deliberately.** `store/verdict` reaches `store/ledger`, which imports
    // `core/state`, which imports the distill gate — so a static edge from this module to the store closes a cycle that
    // runs back through the gate that calls it. `openLedgerProblems` used to live behind exactly this dynamic import for
    // exactly this reason; the edge is the same, the home is better.
    const { openLedgerProblems } = await import('../store/verdict.js');
    const claims = await openLedgerProblems(root, taskId);
    // A record that does not describe the current content contributes no findings — those were about other content.
    const findings = record.boundToCurrentRevision ? record.findings : [];
    return {
        ok: true,
        mode,
        openProblems: openProblemsOf({ findings, claims }),
        problems: mergeBlockingProblems({ mode, findings, claims }),
        exists: Object.keys(record.record).length > 0,
        boundToCurrentRevision: record.boundToCurrentRevision,
        findings,
        record: record.record,
    };
}
