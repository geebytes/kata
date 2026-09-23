/**
 * The record that a finding's falsifier was **shown reddening** — the fact a repair obligation now requires.
 *
 * The reason it exists is measured rather than argued: the closure criterion answered a finding-shaped obligation on *any*
 * passing evidence for its criterion, so a repair that added an assertion which cannot fail closed exactly like one that added
 * an assertion which can, and the difference was invisible everywhere. Three untested criterion clauses closed a repair batch
 * with `obligations 0` on the change this was found on.
 *
 * A falsifier is *the check that must redden under the defect it names* — and by the time the repair is done the check passes,
 * so a passing check proves nothing about its sensitivity. Showing it redden means putting the defect back:
 *
 *   1. run the check — it must pass, or the repair is not done and this is a different error
 *   2. re-introduce the defect, run it again — it must fail, and that failure is the reddening
 *   3. restore
 *
 * That is the mutation verification this line had been doing by hand. The tool cannot invent step 2 — knowing how to
 * re-introduce a defect is knowledge only the repairer has — so the mutation is declared, and the tool records what it
 * observed rather than accepting a claim about it.
 */
import { join } from 'node:path';
import { kataDir } from '../core/layout.js';
import { readValidatedOptional } from '../core/schema.js';

export type FalsifierReddening = {
    findingId: string;
    /** The check that reddened — the selector, as it was run. */
    check: string;
    /** The mutation that re-introduced the defect, declared by the repairer because only it knows. */
    mutation: string;
    /** The revision the reddening was observed on. **Consumed** by the criterion, so a later re-seal cannot inherit a stale proof. */
    revisionId: string;
    reddenedAt: string;
    /**
     * The three exit codes the producer observed: the check before the mutation, under it, and after the restore.
     *
     * This is what makes "the check ran" a recorded fact rather than a claim — AC-4's rule is that a falsifier naming a check
     * which was never run does not close the obligation, and a record with no observed runs is exactly that.
     */
    observed: { before: number; mutated: number; after: number };
    /** What the tree was when the three steps ran, so a reader can see whether this proof still describes the content. */
    observedTreeDigest?: string;
    /** The declared paths that differed from the sealed revision at that moment. */
    observedDrift?: string[];
};

export type FalsifierReddeningLedger = {
    reddenings: FalsifierReddening[];
    /** Optional so a ledger written before this shape existed stays valid. */
    absences?: FalsifierAbsence[];
    updatedAt: string;
};

export function falsifierReddeningsPath(root: string, taskId: string): string {
    return join(kataDir(root), 'tasks', taskId, 'falsifier-reddenings.json');
}

export async function readFalsifierReddenings(root: string, taskId: string): Promise<FalsifierReddening[]> {
    // Validated, and **not swallowed**: this module was written an hour after the same defect was fixed in `readObligations`,
    // and the independent round found it here — a ledger read without a schema, with a failure reading as an absence. The
    // only artefact in the task store read that way, in the change whose subject is exactly this.
    const record = await readValidatedOptional<FalsifierReddeningLedger>('falsifier-reddenings', falsifierReddeningsPath(root, taskId));
    return record?.reddenings ?? [];
}

/**
 * Records a reddening. The caller supplies what only it can know — the mutation, because re-introducing a defect is the
 * repairer’s knowledge — and nothing else: the check and the revision are the ones the run actually used.
 */
export async function recordFalsifierReddening(
    root: string,
    taskId: string,
    reddening: FalsifierReddening,
): Promise<FalsifierReddening> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    await mutateTaskArtefact(root, taskId, falsifierReddeningsPath(root, taskId), async () => {
        const existing = await readFalsifierReddenings(root, taskId);
        // One finding has one reddening: re-recording replaces, so a stale proof cannot sit beside a fresh one and be read
        // as a second fact.
        const reddenings = existing.filter((entry) => entry.findingId !== reddening.findingId);
        reddenings.push(reddening);
        return `${JSON.stringify({ reddenings, updatedAt: reddening.reddenedAt }, null, 2)}\n`;
    });
    return reddening;
}

/**
 * True when this finding has a reddening recorded that **counts** — the single question the closure criterion asks.
 *
 * Three conditions, and each exists because of a finding: the finding must match; the revision must be the one being
 * resolved, or a later re-seal inherits a proof about different content; and the runs must have been observed, or a record
 * that merely names a check closes an obligation (AC-4).
 */
export function hasReddening(
    reddenings: FalsifierReddening[],
    findingId: string,
    revisionId?: string,
): boolean {
    return reddenings.some((reddening) =>
        reddening.findingId === findingId
        && (revisionId === undefined || reddening.revisionId === revisionId)
        && observedReddening(reddening));
}

/** The three observed exit codes have to be the shape a reddening actually has: green, red, green. */
function observedReddening(reddening: FalsifierReddening): boolean {
    const observed = reddening.observed;
    return Boolean(observed) && observed.before === 0 && observed.mutated !== 0 && observed.after === 0;
}

/**
 * A repair whose subject is not code, so **no check can be shown reddening** — recorded rather than granted.
 *
 * The criterion asks for the check that must redden under the defect, which presupposes the repair changed code some check
 * exercises. A repair to a test, or to a document, has no such check — and the third independent round produced exactly two of
 * those: cg3-f1 (a sentence in a design doc) and cg3-f3 (the enumeration inside a test), which no mutation could redden.
 *
 * Without this shape the rule forces one of two worse things: a fake mutation, or an obligation that can never close. So the
 * absence is a **recorded fact with a reason** — written by a command, visible in `status`, and never something a repair
 * grants itself silently.
 */
export type FalsifierAbsence = {
    findingId: string;
    /** Why no falsifier exists for this repair. Required, because the shape exists to be explained rather than used. */
    reason: string;
    revisionId: string;
    recordedAt: string;
};

export async function readFalsifierAbsences(root: string, taskId: string): Promise<FalsifierAbsence[]> {
    const record = await readValidatedOptional<FalsifierReddeningLedger>('falsifier-reddenings', falsifierReddeningsPath(root, taskId));
    return record?.absences ?? [];
}

export async function recordFalsifierAbsence(root: string, taskId: string, absence: FalsifierAbsence): Promise<FalsifierAbsence> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    await mutateTaskArtefact(root, taskId, falsifierReddeningsPath(root, taskId), async () => {
        const record = await readValidatedOptional<FalsifierReddeningLedger>('falsifier-reddenings', falsifierReddeningsPath(root, taskId));
        const absences = (record?.absences ?? []).filter((entry) => entry.findingId !== absence.findingId);
        absences.push(absence);
        return `${JSON.stringify({ reddenings: record?.reddenings ?? [], absences, updatedAt: absence.recordedAt }, null, 2)}\n`;
    });
    return absence;
}

/**
 * The disposition a repair carries: a reddening, or a recorded absence. **One question, two shapes** — and the second is not a
 * loophole: it is a fact written by a command with a reason, which is what makes it auditable rather than granted.
 */
export function hasFalsifierDisposition(
    reddenings: FalsifierReddening[],
    absences: FalsifierAbsence[],
    findingId: string,
    revisionId?: string,
): boolean {
    if (hasReddening(reddenings, findingId, revisionId)) return true;
    return absences.some((absence) => absence.findingId === findingId
        && (revisionId === undefined || absence.revisionId === revisionId)
        && absence.reason.trim().length > 0);
}
