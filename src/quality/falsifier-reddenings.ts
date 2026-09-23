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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kataDir } from '../core/layout.js';

export type FalsifierReddening = {
    findingId: string;
    /** The check that reddened — the selector, as it was run. */
    check: string;
    /** The mutation that re-introduced the defect, declared by the repairer because only it knows. */
    mutation: string;
    /** The revision the reddening was observed on. Recorded so a later re-seal cannot inherit a stale proof. */
    revisionId: string;
    reddenedAt: string;
};

export type FalsifierReddeningLedger = {
    reddenings: FalsifierReddening[];
    updatedAt: string;
};

export function falsifierReddeningsPath(root: string, taskId: string): string {
    return join(kataDir(root), 'tasks', taskId, 'falsifier-reddenings.json');
}

export async function readFalsifierReddenings(root: string, taskId: string): Promise<FalsifierReddening[]> {
    try {
        const parsed = JSON.parse(await readFile(falsifierReddeningsPath(root, taskId), 'utf8')) as FalsifierReddeningLedger;
        return Array.isArray(parsed.reddenings) ? parsed.reddenings : [];
    } catch {
        return [];
    }
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

/** True when this finding has a reddening recorded — the single question the closure criterion asks. */
export function hasReddening(reddenings: FalsifierReddening[], findingId: string): boolean {
    return reddenings.some((reddening) => reddening.findingId === findingId);
}
