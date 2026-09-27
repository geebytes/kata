import { readCurrentTaskRevision } from './revision.js';
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
    const revision = await readCurrentTaskRevision(root, taskId);
    const { readTask } = await import('../core/task.js');
    const task = await readTask(root, taskId).catch(() => null);
    const surfaces = surfaceDigests(revision, task ?? {});
    // §7.4: the freeze identity is delegated to one producer. Recomputing it here from a private guess at `node` and
    // `reviewPolicyHash` would mint a *different* identity for the same candidate, and every verdict would then refuse
    // to bind — a fabricated semantic surface. One derivation, many consumers.
    const { candidateFreezeHashFor } = await import('../quality/review-ir.js');
    const freezeHash = task
        ? await candidateFreezeHashFor(root, taskId, 'review').catch(() => undefined)
        : undefined;
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
    const scope = options.scope ?? 'full';
    if (!current.revisionId) return !artifact.revisionId;
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
