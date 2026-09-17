import { readCurrentTaskRevision } from './revision.js';

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
}

export interface RevisionIdentity {
    revisionId: string | null;
    manifestHash: string | null;
}

/** The identity a verdict should be stamped with, read from one place so no writer re-derives it. */
export async function currentRevisionIdentity(root: string, taskId: string): Promise<RevisionIdentity> {
    const revision = await readCurrentTaskRevision(root, taskId);
    return { revisionId: revision?.id ?? null, manifestHash: revision?.manifestHash ?? null };
}

/** The fields to spread into a verdict artefact, omitting what is not known. */
export function revisionBindingFields(identity: RevisionIdentity): VerdictBinding {
    return {
        ...(identity.revisionId ? { revisionId: identity.revisionId } : {}),
        ...(identity.manifestHash ? { manifestHash: identity.manifestHash } : {}),
    };
}

/**
 * Whether a verdict still speaks for the current revision.
 *
 * With a revision present, the id or the content has to agree — never neither. With **nothing** sealed, a verdict that
 * names a revision is speaking about one that is no longer there (so it does not bind), while a verdict that names none
 * stands on its own — which is the state a gate is created and approved in before anything is sealed.
 */
export function bindsToRevision(artifact: VerdictBinding | null | undefined, current: RevisionIdentity): boolean {
    if (!artifact) return false;
    if (!current.revisionId) return !artifact.revisionId;
    if (artifact.revisionId === current.revisionId) return true;
    return Boolean(artifact.manifestHash) && artifact.manifestHash === current.manifestHash;
}
