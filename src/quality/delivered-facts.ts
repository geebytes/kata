/**
 * The delivered-fact ledger: what a previous round read, addressed by content.
 *
 * This is the externalisation half of the retrieval layer, and the reason it is not a cache is the unit. A file cache saves
 * I/O; the cost here is **context** — every turn re-sends the accumulated transcript, and on a measured round that was 48×
 * replay of a 205K context. So what is stored is not the text but the **fact**: this path, at this content hash, was read,
 * and this is what was concluded from it.
 *
 * Content addressing is what makes it safe to reuse: a fact is live only while the file still hashes to what it did when the
 * fact was recorded. A repair changes the file, the hash no longer matches, the fact goes stale, and the next round must read
 * the file again — which is correct, because the file changed. A fact whose hash still matches describes content the round
 * would otherwise re-read to learn the same thing.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kataDir } from '../core/layout.js';

export type DeliveredFact = {
    /** Stable across rounds: `path@sha256`, so re-recording the same content does not duplicate. */
    id: string;
    path: string;
    sha256: string;
    /** What the round concluded from it. A reference, not a transcript: the next round decides whether to re-read. */
    note: string;
    recordedAt: string;
};

export type DeliveredFactLedger = {
    facts: DeliveredFact[];
    updatedAt: string;
};

export function deliveredFactsPath(root: string, taskId: string): string {
    return join(kataDir(root), 'tasks', taskId, 'delivered-facts.json');
}

/** The content hash of a path as it is now, or null when the path is gone. */
export async function contentHashOf(root: string, path: string): Promise<string | null> {
    try {
        const content = await readFile(join(root, path));
        return createHash('sha256').update(content).digest('hex');
    } catch {
        return null;
    }
}

export async function readDeliveredFactLedger(root: string, taskId: string): Promise<DeliveredFactLedger> {
    try {
        const parsed = JSON.parse(await readFile(deliveredFactsPath(root, taskId), 'utf8')) as DeliveredFactLedger;
        return { facts: Array.isArray(parsed.facts) ? parsed.facts : [], updatedAt: parsed.updatedAt ?? '' };
    } catch {
        return { facts: [], updatedAt: '' };
    }
}

/**
 * Records what a round read. The hash is taken here rather than accepted from the caller, because a caller-supplied hash is
 * an assertion about content the ledger exists to verify — the same reason telemetry is measured rather than typed in.
 */
export async function recordDeliveredFact(
    root: string,
    taskId: string,
    input: { path: string; note: string; at: string },
): Promise<DeliveredFact> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    const sha256 = await contentHashOf(root, input.path);
    if (!sha256) {
        throw new Error(`Cannot record a delivered fact for '${input.path}': the path does not exist, so there is no content to address.`);
    }
    const fact: DeliveredFact = {
        id: `${input.path}@${sha256}`,
        path: input.path,
        sha256,
        note: input.note,
        recordedAt: input.at,
    };
    await mutateTaskArtefact(root, taskId, deliveredFactsPath(root, taskId), async () => {
        const ledger = await readDeliveredFactLedger(root, taskId);
        // Re-recording the same content replaces the note rather than duplicating the fact: one path at one hash is one fact.
        const facts = ledger.facts.filter((entry) => entry.id !== fact.id);
        facts.push(fact);
        return `${JSON.stringify({ facts, updatedAt: input.at }, null, 2)}\n`;
    });
    return fact;
}

/**
 * Splits the ledger into facts that still describe the content on disk and facts that do not.
 *
 * The split is the whole point: a **stale** fact is not a fact about this revision, so offering it would be worse than
 * offering nothing — it would describe a version of the file that no longer exists. Both halves are returned rather than only
 * the live one, because "this was read and has since changed" is itself information a round should have.
 */
export async function readDeliveredFacts(
    root: string,
    taskId: string,
): Promise<{ live: DeliveredFact[]; stale: DeliveredFact[] }> {
    const ledger = await readDeliveredFactLedger(root, taskId);
    const live: DeliveredFact[] = [];
    const stale: DeliveredFact[] = [];
    for (const fact of ledger.facts) {
        const current = await contentHashOf(root, fact.path);
        (current === fact.sha256 ? live : stale).push(fact);
    }
    return { live, stale };
}
