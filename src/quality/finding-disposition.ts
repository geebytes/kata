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

export type FindingDisposition = 'open' | 'fixed' | 'deferred' | 'accepted' | 'routed';

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
    /**
     * What else the repair will touch, as the pass that filed it observed.
     *
     * Not a repair recipe — the pass is not the fix's author — but an observation it already holds: it has just read the call
     * sites, so it knows what a change there reaches. **Measured cost of its absence: one repair broke eleven fixtures across six
     * files, and running the suite was the only thing that said so.**
     */
    impact?: string;
    /** Where else the same defect exists, so one revision can fix the class rather than one instance of it. */
    classInstances?: string[];
    /** The check that must redden under this defect, so the repair is checkable rather than believed. */
    falsifier?: string;
    /** Where the finding lives: `review` for `review.json`, the node name for an adversarial record. */
    /**
     * Which record holds the finding.
     *
     * `review` is the reviewer's own `review.json`; an adversarial pass's finding is `adversarial-<node>`. The two used to
     * share the label `review` — the node name — so a reader could not tell which file a finding came from, and a write
     * aimed at the wrong one failed with an ENOENT on a record that does not exist for that task.
     */
    source: 'review' | `adversarial-${AdversarialNode}`;
    /** The revision the record that raised this finding answered, when it recorded one. */
    revisionId?: string;
    manifestHash?: string;
}

/** The severity that may be dispositioned; the rest must be repaired (I1). */
export function mayBeDispositioned(severity: string): boolean {
    return !isTerminalSeverity(severity);
}

/** The binding fields of a record, for carrying onto its findings. */
function bindingOf(record: { revisionId?: string; manifestHash?: string } | null | undefined): { revisionId?: string; manifestHash?: string } {
    return {
        ...(record?.revisionId ? { revisionId: record.revisionId } : {}),
        ...(record?.manifestHash ? { manifestHash: record.manifestHash } : {}),
    };
}

/** A finding from either record, with `open` as the answer for one that never said (老记录 treated as open). */
function track(
    finding: ReviewFinding | AdversarialFinding,
    source: TrackedFinding['source'],
    /** The record's own binding, carried onto each of its findings so a reader can tell which revision raised it. */
    binding: { revisionId?: string; manifestHash?: string } = {},
): TrackedFinding {
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
        // **The three fields the contract declares and this function was dropping** (`rba8-f1`, blocking). A field-by-field
        // reconstruct is a transport, and a transport that omits a field makes it invisible to every reader downstream —
        // measured: `roundMayClose` fed a list whose `classInstances` was always undefined and therefore returned
        // `mayClose: true` unconditionally, `repairBriefing`'s tracked branch emitted no `impact` or `classInstances`, and
        // `classesOfFindings` could never acquire a class for a finding a pass had filed. That is this change's own class — a
        // declaration (`TrackedFinding` names the fields) whose transport does not carry them — and it is the *third* time on
        // this line: the status projection's inline restatement had already dropped `impact`, and the delta type's second
        // declaration had silently truncated a field.
        ...(finding.impact ? { impact: finding.impact } : {}),
        ...(finding.classInstances ? { classInstances: finding.classInstances } : {}),
        ...(finding.falsifier ? { falsifier: finding.falsifier } : {}),
        // The binding a finding was raised under. A finding carries none of its own — it is written into a record, and the
        // record is what says which revision the pass answered — so without this a reader could not tell a finding about
        // the revision in hand from one about the revision before it.
        ...(binding.revisionId ? { revisionId: binding.revisionId } : {}),
        ...(binding.manifestHash ? { manifestHash: binding.manifestHash } : {}),
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

    // **A record that fails validation must not read as an absent record.** These two reads used `.catch(() => null)`, so a pass
    // whose record missed a required field contributed *no findings at all* — silently, and indistinguishably from a pass that
    // recorded none. Measured while writing the transport falsifier: a fixture whose hypothesis said `conclusion` instead of
    // `outcome` produced an empty list with no error, and a termination condition reading that list would report "may close".
    // `readValidatedOptional` already distinguishes a missing file (null) from an invalid one (throw), which is exactly how
    // `readObligations` was fixed for the same defect (`cg-f3`); this re-introduced the swallow one layer down.
    const review = await readValidatedOptional<{ findings?: ReviewFinding[]; revisionId?: string; manifestHash?: string }>('review', reviewPath(root, taskId));
    for (const finding of review?.findings ?? []) tracked.push(track(finding, 'review', bindingOf(review)));

    for (const node of ['verify', 'review'] as const) {
        const path = adversarialReviewPath(root, taskId, node);
        const record = await readValidatedOptional<{ findings?: AdversarialFinding[]; revisionId?: string; manifestHash?: string }>(
            'adversarial-review',
            path,
        );
        for (const finding of record?.findings ?? []) tracked.push(track(finding, `adversarial-${node}`, bindingOf(record)));

        // AC-6: the node record is one slot, so a pass that does not re-raise a finding would erase it. The history holds
        // the passes it replaced, and a finding stays tracked until a disposition says otherwise — which is what "still
        // open" has to mean if a later pass cannot delete an earlier one's statement.
        const history = await readFile(path.replace(/\.json$/, '-history.json'), 'utf8')
            .then((text) => JSON.parse(text) as Array<{ findings?: AdversarialFinding[]; revisionId?: string; manifestHash?: string }>)
            .catch(() => [] as Array<{ findings?: AdversarialFinding[]; revisionId?: string; manifestHash?: string }>);
        for (const past of history) {
            for (const finding of past.findings ?? []) tracked.push(track(finding, `adversarial-${node}`, bindingOf(past)));
        }
    }

    // One finding is one finding, however many passes reported it: the live record's copy wins, because its disposition
    // is the one a command can still change.
    const byId = new Map<string, TrackedFinding>();
    for (const finding of tracked) {
        const seen = byId.get(finding.id);
        if (!seen) {
            byId.set(finding.id, finding);
            continue;
        }
        // Same source: the **first** occurrence is the live record's, because the live record is read before the history.
        // Keeping the later copy inverted this precedence (kgs3-f1): the history entry overwrote the live record, so every
        // disposition written through a command was invisible to every reader and the sealed change record inherited the
        // stale value.
        if (seen.source === finding.source) continue;
        // Different sources: the adversarial record is what a disposition command writes to, so it is the authoritative one.
        if (!seen.source.startsWith('adversarial-') && finding.source.startsWith('adversarial-')) byId.set(finding.id, finding);
    }
    return [...byId.values()];
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
    /**
     * The coverage verdict, when the finding is about a declared instrument (§21.2).
     *
     * This is the one thing that may relax I1, and it is deliberately narrow: a `blocking`/`major` finding **outside a
     * dimension the instrument's declaration excludes** is not a defect to repair but a boundary to record, and without
     * this the adversarial search against any guard has no terminating condition — it finds the unguarded dimension every
     * round until someone deletes the guard.
     *
     * It is not a loophole: the classification requires the finding to **quote a dimension someone declared in advance**
     * (`classifyFindingCoverage` refuses otherwise), the reason still has to be given, and the closure is displayed at
     * review/judge/archive.
     */
    coverage?: { classification: string; dimension?: string; canonicalStatement?: string } | null,
): string | null {
    // AC-4. `routed` is the one disposition allowed for **blocking and major**, because it is the exit for a finding whose
    // repair lies outside the change that raised it — the case that until now had no answer but "repair it" (the loop) or
    // `waive` (which sets findings to empty). Not a loophole: it requires a reason naming what will carry the finding, and
    // the command checks that the named change exists.
    if (disposition === 'routed') {
        if (!reason?.trim()) {
            return `Routing ${finding.id} requires --reason naming the change that will carry it: a finding may leave this `
                + 'change, but it may not leave unnamed.';
        }
        return null;
    }
    const beyondDeclared = coverage?.classification === 'beyond-declared-coverage';
    if (!mayBeDispositioned(finding.severity) && !beyondDeclared) {
        return `Finding ${finding.id} is '${finding.severity}' and must be repaired: only minor and nit findings can be `
            + `deferred or accepted. Fix it, or record evidence that it does not hold.`
            + (finding.path ? ` (A finding about a declared instrument, outside a declared dimension, is the one exception — `
                + `see the instrument's boundary declaration.)` : '');
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
    // The label names the record, so the path follows from it directly — no guessing between the two.
    const path = source === 'review'
        ? reviewPath(root, taskId)
        : adversarialReviewPath(root, taskId, source.replace('adversarial-', ''));
    let found = false;
    await mutateTaskArtefact(root, taskId, path, async () => {
        const raw = JSON.parse(await readFile(path, 'utf8')) as { findings?: Array<Record<string, unknown>> };
        const next = JSON.parse(JSON.stringify(raw)) as { findings?: Array<Record<string, unknown>> };
        for (const finding of next.findings ?? []) {
            if (finding.id !== findingId) continue;
            found = true;
            finding.disposition = event.disposition;
            if (event.reason !== undefined) finding.dispositionReason = event.reason;
            if (event.by !== undefined) finding.dispositionBy = event.by;
            finding.dispositionAt = event.at;
        }
        // **Before** the write, not after it (kgs3-f2, claim two). The guard this replaces ran after `mutateTaskArtefact`
        // had already replaced the file, so its message — "the write is refused rather than left for the next reader to
        // discover" — described something it did not do: the record was written and then the command threw. Validating the
        // record that *would* be written is the pattern the matrix command already uses, and it can honestly refuse.
        const { validate } = await import('../core/schema.js');
        validate(source === 'review' ? 'review' : 'adversarial-review', next);
        return `${JSON.stringify(next, null, 2)}\n`;
    });
    // kgs-f1, the blocking finding, and it is the reason this line exists: `routed` was added to the type and the command
    // but to no schema's enum, and this writer validated nothing — so routing a finding left the record schema-invalid, and
    // every later read of it failed. The value was caught by an independent pass rather than by this path. So the write is
    // checked against the same reader everything else uses: a disposition this platform cannot read back is refused here,
    // at the moment it is written, rather than discovered by whoever reads the record next.
    if (found) {
        const readable = await readTrackedFindings(root, taskId).catch(() => null);
        if (!readable || !readable.some((entry) => entry.id === findingId && entry.disposition === event.disposition)) {
            throw new Error(
                `Dispositioning '${findingId}' as '${event.disposition}' validated before the write but does not read back `
                + 'afterwards. The record passed the schema and the write landed, so this is not a rejected disposition — it '
                + 'means something else about the record changed underneath the write, and it is reported rather than '
                + 'swallowed.',
            );
        }
    }
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
