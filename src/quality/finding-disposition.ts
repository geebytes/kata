import { readFile } from 'node:fs/promises';
import { readValidatedOptional } from '../core/schema.js';
import { reviewPath, adversarialReviewPath, taskPath } from '../core/layout.js';
import type { ReviewFinding, ReviewSeverity } from './reviewer.js';
import type { AdversarialFinding, AdversarialNode } from './adversarial.js';
import { isTerminalSeverity } from './finding-lifecycle.js';

/**
 * A finding's disposition: what has been decided about it, and by whom.
 *
 * G1 of the finding-lifecycle design: a finding used to have exactly two states — present, or gone. "Known, decided to
 * defer, remembered" had nowhere to live, so it survived only in the author's notes, came back as a new finding in the
 * next pass, and was invisible at the close of the task. A review that is honestly reported is not the same as a review
 * with an empty findings list, and the platform could not tell the two apart.
 *
 * The rules are the design's invariants:
 *   - I1: `blocking`/`major` can be neither deferred nor accepted — the commands refuse, and refuse loudly;
 *   - I2: a deferral is explicit and carries `reason`/`by`/`at`, and it is printed wherever findings are;
 *   - I5: a disposition changes *when* a finding is read, never *whether* it must be seen.
 */

export type FindingDisposition = 'open' | 'fixed' | 'deferred' | 'accepted';

export interface DispositionEvent {
    disposition: FindingDisposition;
    reason?: string;
    by?: string;
    at: string;
}

/** One finding as it is read from either record, with the source it came from. */
export interface TrackedFinding {
    id: string;
    taskId: string;
    /** Either record's vocabulary: the review's `blocking|major|minor|note` or the adversarial `…|nit`. */
    severity: ReviewSeverity | 'nit';
    message: string;
    acceptanceId?: string;
    path?: string;
    disposition: FindingDisposition;
    dispositionReason?: string;
    dispositionBy?: string;
    dispositionAt?: string;
    /** Where the finding lives: `review` for `review.json`, the node name for an adversarial record. */
    source: 'review' | AdversarialNode;
}

/** The severity that may be dispositioned; the rest must be repaired (I1). */
export function mayBeDispositioned(severity: string): boolean {
    return !isTerminalSeverity(severity);
}

/** A finding from either record, with `open` as the answer for one that never said (老记录 treated as open). */
function track(finding: ReviewFinding | AdversarialFinding, source: TrackedFinding['source']): TrackedFinding {
    const dispositioned = finding as ReviewFinding & {
        disposition?: FindingDisposition;
        dispositionReason?: string;
        dispositionBy?: string;
        dispositionAt?: string;
    };
    return {
        id: finding.id,
        taskId: finding.taskId,
        severity: finding.severity,
        message: finding.message,
        ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
        ...(finding.path ? { path: finding.path } : {}),
        disposition: dispositioned.disposition ?? 'open',
        ...(dispositioned.dispositionReason ? { dispositionReason: dispositioned.dispositionReason } : {}),
        ...(dispositioned.dispositionBy ? { dispositionBy: dispositioned.dispositionBy } : {}),
        ...(dispositioned.dispositionAt ? { dispositionAt: dispositioned.dispositionAt } : {}),
        source,
    };
}

/**
 * Every finding the task has recorded, from both places they are recorded.
 *
 * The design asks for one view across the two records (the review's findings and the adversarial passes' findings)
 * because a reader deciding what to do about the task does not care which surface produced a finding — and today neither
 * surface can see the other's.
 */
export async function readTrackedFindings(root: string, taskId: string): Promise<TrackedFinding[]> {
    const tracked: TrackedFinding[] = [];

    const review = await readValidatedOptional<{ findings?: ReviewFinding[] }>('review', reviewPath(root, taskId)).catch(() => null);
    for (const finding of review?.findings ?? []) tracked.push(track(finding, 'review'));

    for (const node of ['verify', 'review'] as const) {
        const record = await readValidatedOptional<{ findings?: AdversarialFinding[] }>(
            'adversarial-review',
            adversarialReviewPath(root, taskId, node),
        ).catch(() => null);
        for (const finding of record?.findings ?? []) tracked.push(track(finding, node));
    }

    return tracked;
}

/** What the brief and the close-of-task must show: everything not fixed, whichever way it was decided. */
export function unfixed(findings: TrackedFinding[]): TrackedFinding[] {
    return findings.filter((finding) => finding.disposition !== 'fixed');
}

export function deferredFindings(findings: TrackedFinding[]): TrackedFinding[] {
    return findings.filter((finding) => finding.disposition === 'deferred' || finding.disposition === 'accepted');
}

/** The reasons a disposition request is refused, or `null` when it is allowed (I1 + the reason requirement). */
export function dispositionDenial(
    finding: TrackedFinding,
    disposition: FindingDisposition,
    reason: string | undefined,
): string | null {
    if (!mayBeDispositioned(finding.severity)) {
        return `Finding ${finding.id} is '${finding.severity}' and must be repaired: only minor and nit findings can be `
            + `deferred or accepted. Fix it, or record evidence that it does not hold.`;
    }
    if ((disposition === 'deferred' || disposition === 'accepted') && !reason?.trim()) {
        return `Dispositioning ${finding.id} as '${disposition}' requires --reason: a decision to live with a finding is `
            + `recorded with why, by whom and when, so the next reader can judge it (a silent disappearance is worse).`;
    }
    return null;
}

/** Writes the disposition into whichever record holds the finding. */
export async function applyDisposition(
    root: string,
    taskId: string,
    source: TrackedFinding['source'],
    findingId: string,
    event: DispositionEvent,
): Promise<boolean> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    const path = source === 'review' ? reviewPath(root, taskId) : adversarialReviewPath(root, taskId, source);
    let found = false;
    await mutateTaskArtefact(root, taskId, path, async () => {
        const raw = JSON.parse(await readFile(path, 'utf8')) as { findings?: Array<Record<string, unknown>> };
        for (const finding of raw.findings ?? []) {
            if (finding.id !== findingId) continue;
            found = true;
            finding.disposition = event.disposition;
            if (event.reason !== undefined) finding.dispositionReason = event.reason;
            if (event.by !== undefined) finding.dispositionBy = event.by;
            finding.dispositionAt = event.at;
        }
        return `${JSON.stringify(raw, null, 2)}\n`;
    });
    return found;
}

/** A short human line for one finding, used by every surface that prints them. */
export function describeFinding(finding: TrackedFinding): string {
    const decided = finding.disposition === 'open'
        ? ''
        : ` [${finding.disposition}${finding.dispositionReason ? `: ${finding.dispositionReason}` : ''}${finding.dispositionBy ? ` by ${finding.dispositionBy}` : ''}]`;
    const where = finding.path ? ` (${finding.path})` : '';
    return `${finding.severity} ${finding.id}${where}: ${finding.message}${decided}`;
}

/** The task the findings belong to, read only to keep the signature honest about who owns them. */
export async function taskTitle(root: string, taskId: string): Promise<string | null> {
    const task = await readValidatedOptional<{ title?: string }>('task', taskPath(root, taskId)).catch(() => null);
    return task?.title ?? null;
}
