import { readCurrentTaskRevisionState, type CurrentRevisionRead } from './revision.js';
// A dynamic import: the review-ir module reads `workflow/revision`, so a static edge here would close a cycle.
// `candidateFreezeHashFor` is the one producer of the freeze identity (§7.4).
import { surfaceDigests } from '../quality/code-surface.js';


/**
 * How a verdict about a revision is bound to that revision.
 *
 * A verdict — a review, a judgement, a verification, a user's choice at a gate — is about **an artefact**: the content
 * the task owns. Binding it to the revision *id* alone made every re-seal expire every verdict, even when the owned paths
 * were byte-identical: the id covers the manifest hash *and* the check ids, so sealing the same content again issues a
 * new one. Measured effect before this: a re-seal re-asked the user's platform/model choice, re-ran the review, and
 * invalidated the distillation verdicts, all for an artefact nobody had changed.
 *
 * Two fields, one rule: the verdict names the **same revision**, or it names the **same content**. A verdict written
 * before this arrangement has only the id and keeps working through it.
 */
export interface VerdictBinding {
    revisionId?: string;
    manifestHash?: string;
    /**
     * The content identity of the revision's **code** paths (C2).
     *
     * Stamped beside the full manifest so a verdict can answer a narrower question than "is the artefact identical": a pass
     * that verified the code may survive an edit that only touched a governance document. It is stamped on every verdict
     * and **consulted only by the scopes that ask for it** — see `bindsToRevision`'s `scope`.
     */
    codeManifestHash?: string;
    /** The governance-text surface (§22/§24): what a text-only edit may expire, and nothing more. */
    governanceManifestHash?: string;
    /** The declared-instrument surface (§24.4): what an instrument edit may expire, and nothing more. */
    instrumentManifestHash?: string;
    /**
     * The frozen candidate this verdict answered (§7.4).
     *
     * `manifestHash` covers only the *declared* owned paths, so a change committed outside the declaration left it
     * identical while the reviewed content had moved. When both sides can name a freeze it is the binding; a verdict
     * written before this contract keeps the older rule rather than failing.
     */
    candidateFreezeSha256?: string;
}

/**
 * What a verdict verified, and therefore what may leave it standing.
 *
 * `full` is the default and the strictest answer: any difference in the owned paths expires the verdict. `code` is for a
 * verdict whose subject is the code, which the pass-cost measurement showed was being re-earned for governance-text edits
 * (three cycles in one day, about an hour each, for roughly twenty words).
 *
 * The default is deliberately `full` — **no existing caller is loosened by this interface**. A gate opts in by asking for
 * `code` scope, one call site at a time, with its own test.
 */
export type VerdictScope = 'full' | 'code' | 'instrument' | 'governance';

export interface RevisionIdentity {
    revisionId: string | null;
    manifestHash: string | null;
    /**
     * The revision's code-only content identity. Optional because a caller may hand-build an identity (and because the
     * field did not exist before C2); `currentRevisionIdentity` always fills it, and a `code`-scoped binding refuses to
     * match when either side is missing — the full invalidation the proposal requires.
     */
    codeManifestHash?: string | null;
    /** The governance-text surface (§22/§24): a text-only edit invalidates what this surface was verified for. */
    governanceManifestHash?: string | null;
    /** The declared-instrument surface (§24.4): instrument edits invalidate the instrument surface only. */
    instrumentManifestHash?: string | null;
    /** The frozen candidate the current revision would be certified under (§7.4), when it can be derived. */
    candidateFreezeSha256?: string | null;
}

/**
 * The identity a verdict should be stamped with, read from one place so no writer re-derives it.
 *
 * The task is read for its `instruments[]` declaration (§24.4): without it, a declared instrument falls into the code
 * bucket and its edits invalidate a pass about the deliverable — the structural cause of four wasted rounds in one day.
 */
export async function currentRevisionIdentity(root: string, taskId: string): Promise<RevisionIdentity> {
    // **A revision nobody can read must not become an identity that says "nothing was sealed".** `bindsToRevision`
    // defines a missing `revisionId` as exactly that, so an unreadable artefact used to make every task-level choice
    // bind — the gate then reused an answer the human gave about other content, in the one direction this boundary must
    // never take by itself. Reading the three states here is what keeps "absent" and "unreadable" apart at the point the
    // identity is minted; callers that refuse (the choice gate) get the refusal from this throw, which is the behaviour
    // the boundary is named for.
    return currentRevisionIdentityFrom(await readCurrentTaskRevisionState(root, taskId), root, taskId);
}

/**
 * The same identity, derived from **a read already in hand**.
 *
 * A gate that has asked whether the revision is readable must not then read the same file again to derive the identity:
 * the pointer is written non-atomically (`revision.ts`), so the second read can answer differently from the first and
 * throw out of a gate that has already decided. One question, one read, one answer.
 */
export async function currentRevisionIdentityFrom(
    read: CurrentRevisionRead,
    root: string,
    taskId: string,
): Promise<RevisionIdentity> {
    if (read.kind === 'unreadable') {
        throw new Error(`The revision this decision is about cannot be read: ${read.detail}`);
    }
    const revision = read.kind === 'current' ? read.revision : null;
    const { readValidatedOptional } = await import('../core/schema.js');
    const { taskPath } = await import('../core/layout.js');
    // **A damaged `task.json` is not an absent one.** The catch-all here answered `null`, and the line below substituted
    // `{}` for it — so a corrupt record produced a *different* identity (empty surfaces) that then refused every verdict
    // for a reason that named none of this. The tolerant reader answers `null` for ENOENT only and reports the rest.
    const task = await readValidatedOptional<import('../core/task.js').TaskRecord>('task', taskPath(root, taskId));
    const surfaces = surfaceDigests(revision, task ?? {});
    // §7.4: the freeze identity is delegated to one producer. Recomputing it here from a private guess at `node` and
    // `reviewPolicyHash` would mint a *different* identity for the same candidate, and every verdict would then refuse
    // to bind — a fabricated semantic surface. One derivation, many consumers.
    const { candidateFreezeHashFor } = await import('../quality/review-ir.js');
    // The read this identity was derived from is handed to the freeze-hash producer: reading the same non-atomic file
    // again could yield a *second* state, and the identity would then describe two things at once.
    // **And the second catch-all at the same site is gone with the first.** `.catch(() => undefined)` turned a refusal
    // from the freeze-hash producer into the *same* "no freeze hash" an absent task produces, which is the substitution
    // this file was fixed for one line above — leaving it here would have kept the weaker identity reachable.
    const freezeHash = task ? await candidateFreezeHashFor(root, taskId, 'review', read) : undefined;
    return {
        revisionId: revision?.id ?? null,
        manifestHash: revision?.manifestHash ?? null,
        codeManifestHash: surfaces.code,
        governanceManifestHash: surfaces.governance,
        instrumentManifestHash: surfaces.instrument,
        ...(freezeHash ? { candidateFreezeSha256: freezeHash } : {}),
    };
}

/** The fields to spread into a verdict artefact, omitting what is not known. */
export function revisionBindingFields(identity: RevisionIdentity): VerdictBinding {
    return {
        ...(identity.revisionId ? { revisionId: identity.revisionId } : {}),
        ...(identity.manifestHash ? { manifestHash: identity.manifestHash } : {}),
        ...(identity.codeManifestHash ? { codeManifestHash: identity.codeManifestHash } : {}),
        ...(identity.governanceManifestHash ? { governanceManifestHash: identity.governanceManifestHash } : {}),
        ...(identity.instrumentManifestHash ? { instrumentManifestHash: identity.instrumentManifestHash } : {}),
        ...(identity.candidateFreezeSha256 ? { candidateFreezeSha256: identity.candidateFreezeSha256 } : {}),
    };
}

/**
 * **Whether a record names any binding at all** — a revision, a content identity, a surface identity, or a freeze.
 *
 * This is the one fact that separates "this record is about some content" from "this record is about nothing", and it is
 * asked rather than inferred from the fields at the place the answer is used (round 9's F1: the gate's own predicate read
 * `!record.revisionId && !record.manifestHash`, `bindsToRevision` read its own fall-through, and `assertRevision` carried a
 * third exemption, so one fact had three answers from three symbols and no instrument decided any of them).
 */
export function namesAnyBinding(record: VerdictBinding | null | undefined): boolean {
    return Boolean(record
        && (record.revisionId || record.manifestHash || record.codeManifestHash
            || record.governanceManifestHash || record.instrumentManifestHash
            || record.candidateFreezeSha256));
}

/**
 * **What a record that names no binding at all answers, for whatever the current identity is.**
 *
 * A record that names no content is not a statement about any content: it speaks only while **nothing** is sealed — the
 * state a gate is created and approved in before the first seal — and it stops speaking the moment a revision exists,
 * because from then on "the current content" is a fact the record never named. Before round 9 this was the fall-through of
 * `bindsToRevision` while the gate's own predicate answered the opposite for the same record.
 */
export function unboundBindingSpeaksForCurrentContent(current: RevisionIdentity): boolean {
    return !current.revisionId;
}

/**
 * Whether a verdict still speaks for the current revision.
 *
 * With a revision present, the id or the content has to agree — never neither. With **nothing** sealed, a verdict that
 * names a revision is speaking about one that is no longer there (so it does not bind), while a verdict that names none
 * stands on its own — which is the state a gate is created and approved in before anything is sealed.
 */
export function bindsToRevision(
    artifact: VerdictBinding | null | undefined,
    current: RevisionIdentity,
    options: { scope?: VerdictScope } = {},
): boolean {
    if (!artifact) return false;
    // **A record that names no binding at all is answered here, not by a fall-through**, so the fact has one home that
    // `recordSpeaksForCurrentContent` asks as well — see `unboundBindingSpeaksForCurrentContent`.
    if (!namesAnyBinding(artifact)) return unboundBindingSpeaksForCurrentContent(current);
    const scope = options.scope ?? 'full';
    if (!current.revisionId) {
        // **Nothing is sealed, so the only binding that can still be compared is the content one.** A record that names a
        // content identity, against an identity whose content half is known, is compared with it rather than passed over:
        // that is the state the user-choice gate answers in before the first seal, where its identity is widened to the
        // declared content (`contentIdentityFor`). A caller handing in a sealed identity has no content half here — both
        // fields come from the same revision — so the rule that stood before still decides for it: a record naming a
        // revision binds while nothing is sealed, and one that names none stands on its own.
        if (artifact.manifestHash && current.manifestHash) return artifact.manifestHash === current.manifestHash;
        return !artifact.revisionId;
    }
    // §7.4: when both sides can name the frozen candidate, that is the binding — and it takes precedence over the owned
    // manifest, which cannot see a change committed outside the declaration.
    const freezeKnown = Boolean(artifact.candidateFreezeSha256) && Boolean(current.candidateFreezeSha256);
    if (freezeKnown) return artifact.candidateFreezeSha256 === current.candidateFreezeSha256;
    if (scope === 'full' && artifact.revisionId === current.revisionId) return true;
    if (Boolean(artifact.manifestHash) && artifact.manifestHash === current.manifestHash) return true;
    // C2: a code-scoped verdict may outlive an edit that touched only governance text. Both sides must be able to name the
    // code surface — an underivable one (a legacy revision, or an owned set with no code) falls through to `false`, which
    // is the full invalidation the proposal requires when the split cannot be made.
    if (scope === 'code') {
        return Boolean(artifact.codeManifestHash)
            && Boolean(current.codeManifestHash)
            && artifact.codeManifestHash === current.codeManifestHash;
    }
    // §24.4: the instrument surface, so editing the checker does not invalidate a pass about the deliverable — which is
    // what happened four times in one day when those edits landed in the code bucket.
    if (scope === 'instrument') {
        return Boolean(artifact.instrumentManifestHash)
            && Boolean(current.instrumentManifestHash)
            && artifact.instrumentManifestHash === current.instrumentManifestHash;
    }
    if (scope === 'governance') {
        return Boolean(artifact.governanceManifestHash)
            && Boolean(current.governanceManifestHash)
            && artifact.governanceManifestHash === current.governanceManifestHash;
    }
    return false;
}

/**
 * **One answer to "does this existing binding still speak for the current content?"**
 *
 * `bindsToRevision` is that answer for a verdict that is being *stamped*; this is its name for the readers that ask the
 * question about a record already on disk — the user-choice gate's reuse rule, its removal rule and `assertRevision` — and
 * it settles the two facts those readers used to decide for themselves: a record that names no binding at all is answered
 * by `unboundBindingSpeaksForCurrentContent`, and the caller hands in the identity it has **already read**, so no reader
 * derives the current revision a second time inside one decision (the contract `currentRevisionIdentityFrom` states for
 * that non-atomic pointer). Two symbols answering this question is the defect, not the repair.
 */
export function recordSpeaksForCurrentContent(
    record: VerdictBinding | null | undefined,
    current: RevisionIdentity,
    options: { scope?: VerdictScope } = {},
): boolean {
    if (!namesAnyBinding(record)) return unboundBindingSpeaksForCurrentContent(current);
    return bindsToRevision(record, current, options);
}
