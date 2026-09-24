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
    /**
     * The content the three steps actually ran against — the files this proof is about.
     *
     * **This is the good binding, and `revisionId` is the fallback.** `revisionIdFor` derives the id from *every* content
     * digest a seal sees — measured, 718 of them, well beyond a change's owned paths — so binding to the id made every
     * disposition expire on any later commit: a repair could never demonstrate that it had worked, and six dispositions on
     * this line were recorded twice and stale twice. A disposition is a claim about content, and this field is that content.
     */
    pathDigests?: Record<string, string>;
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
async function readAbsences(root: string, taskId: string): Promise<FalsifierAbsence[]> {
    const record = await readValidatedOptional<FalsifierReddeningLedger>('falsifier-reddenings', falsifierReddeningsPath(root, taskId));
    return record?.absences ?? [];
}

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
        // **The absences are carried through, and they were not.** This writer wrote `{ reddenings, updatedAt }` and nothing
        // else, so recording a reddening **erased every recorded absence** — and it did so silently, because the command
        // reports what it recorded and not what it removed. Measured: `cg5-f1`'s absence was accepted at 16:34 and gone when
        // the ledger was read after `cg5-f2`'s reddening was recorded; the seal then refused `cg5-f1` for having no
        // disposition, which was true.
        //
        // The asymmetry is the tell: `recordFalsifierAbsence` preserves `reddenings` and this one did not preserve
        // `absences`. Two shapes in one ledger, and only one writer knew about both — the same defect this line keeps
        // finding, here as a writer that drops a sibling field.
        // **Unconditionally, and my first version was conditioned on `existing.length === 0`** — which reads as "there are no
        // reddenings yet, so there are no absences" and drops them in exactly the case that matters: the first reddening
        // recorded beside an absence. The case caught it, and it is the same shape as the bug it fixes — a writer silently
        // losing a sibling field, now via a condition rather than an omission.
        const absences = await readAbsences(root, taskId);
        return `${JSON.stringify({ reddenings, ...(absences.length > 0 ? { absences } : {}), updatedAt: reddening.reddenedAt }, null, 2)}\n`;
    });
    return reddening;
}

/**
 * True when this finding has a reddening recorded that **counts** — the single question the closure criterion asks.
 *
 * **The binding is to content, not to a revision id.** It used to compare `revisionId` strings, and that made every disposition
 * expire on any later commit: `revisionIdFor` derives the id from the **content digests**, which cover far more than the
 * change's owned paths — measured, a seal's `contentDigests` held 718 entries and two revisions separated only by edits to
 * `src/quality/adversarial.ts`, a path this change does not own. So "freeze content, prove, seal immediately" could not be
 * satisfied: the seal that would close an obligation was the seal that invalidated the proof, and a change could never
 * demonstrate that its own repair had worked. Measured cost: six dispositions recorded twice and stale twice.
 *
 * A disposition is a claim about **content** — the defect was re-introduced and this check reddened. So it counts when the
 * content it was recorded against still matches, which is what `pathDigests` on the record is for: the files the three steps
 * actually ran against. A commit touching something else does not invalidate it; a change to those files does.
 *
 * Three conditions, and each exists because of a finding: the finding must match; the content must still be what the proof was
 * about, or a later seal inherits a proof about different content; and the runs must have been observed, or a record that merely
 * names a check closes an obligation (AC-4).
 */
export function hasReddening(
    reddenings: FalsifierReddening[],
    findingId: string,
    binding?: DispositionBinding,
): boolean {
    return reddenings.some((reddening) =>
        reddening.findingId === findingId
        && revisionCounts(reddening.revisionId, reddening.pathDigests, binding)
        && observedReddening(reddening));
}

/**
 * What a disposition is judged against: the content being resolved, and the revision it belongs to.
 *
 * **One argument, because four call sites each forgot a different half of it** (`rba5-f1`, `rba5-f2`, `rba5-f3` — found by an
 * independent round). The old signature took `revisionId` and `pathDigests` as two independent optional parameters, and the
 * guard's first line was `if (currentRevisionId === undefined) return true` — written so an early caller that knew nothing would
 * not break. That default made forgetting **silent**: the repair-author write passed neither, the seal preflight passed the
 * digests but not the revision, and `adversarial status` passed the revision but not the digests. In two of those four paths the
 * content binding added by this change did not run at all, and the guard reported success.
 *
 * So the binding is now one required object, and `params` absent is a **refusal**, not a pass: a rule whose default is "this
 * counts" is a rule that stops being asked the moment a caller is careless.
 */
export type DispositionBinding = {
    /** The revision being resolved, or `null` when there is no revision to judge against. */
    revisionId: string | null;
    /** The content of that revision, when it has one. */
    pathDigests: Record<string, string> | null;
};

/**
 * Whether a disposition still describes the content it was recorded against.
 *
 * **The content digests are the binding when both sides have them**, because that is what the claim is about. A record without
 * them — every record written before this change — falls back to the revision id, so an existing disposition is neither
 * silently accepted nor silently rejected: it is judged by the weaker rule it was written under, which is the honest reading of
 * a record that did not capture the better one.
 *
 * And when the binding itself is absent, the answer is **no**: without knowing what is being resolved there is nothing to have
 * matched, so "cannot tell" must not read as "still true".
 */
function revisionCounts(
    recordedRevisionId: string,
    recordedPathDigests: Record<string, string> | undefined,
    binding: DispositionBinding | undefined,
): boolean {
    if (!binding) return false;
    const { revisionId: currentRevisionId, pathDigests: currentPathDigests } = binding;
    if (currentRevisionId === null && !currentPathDigests) return false;
    const recorded = recordedPathDigests ?? {};
    if (Object.keys(recorded).length > 0 && currentPathDigests) {
        return Object.entries(recorded).every(([path, digest]) => currentPathDigests[path] === digest);
    }
    return currentRevisionId !== null && recordedRevisionId === currentRevisionId;
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
    /** The revision it was recorded on — the fallback binding, for records written before the content was captured. */
    revisionId: string;
    /** The content the absence is about, so a commit touching something else does not expire it. */
    pathDigests?: Record<string, string>;
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
    binding?: DispositionBinding,
): boolean {
    if (hasReddening(reddenings, findingId, binding)) return true;
    return absences.some((absence) => absence.findingId === findingId
        && revisionCounts(absence.revisionId, absence.pathDigests, binding)
        && absence.reason.trim().length > 0);
}
