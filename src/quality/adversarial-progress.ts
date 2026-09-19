import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { adversarialProgressPath } from '../core/layout.js';
import type { AdversarialNode } from './adversarial.js';

/**
 * The heartbeat of a pass (K1).
 *
 * The proposal's §11 recorded a review pass that **vanished mid-run** — no error, no completion, nothing written — and the
 * only mitigation available was a human convention ("save your findings early"). The seal, the other long-running
 * operation, already writes a heartbeat for exactly this reason (`seal-progress.jsonl`); the inconsistency was kata's, so
 * the fix mirrors it.
 *
 * The trap, from the proposal's own cost table: one append per hypothesis is one extra invocation per hypothesis, and that
 * costs more turns than it saves (5–15 turns per pass). So the line shape is **one line per batch of work** — the batch
 * that just ran — and `note` is meant to be called in the same invocation as the check it accompanies, not before every
 * thought.
 */
export interface ProgressLine {
    type: 'attempt' | 'finding' | 'note';
    at: string;
    node: AdversarialNode;
    /** One line per batch of work, not per hypothesis. */
    hypothesis?: string;
    method?: string;
    outcome?: 'refuted' | 'confirmed' | 'inconclusive';
    /** For a `finding` line: the finding id, so a partial pass's work is readable. */
    findingId?: string;
    /**
     * Tool calls this batch of work took (§18.7).
     *
     * On the heartbeat as well as on the recorded attempt, so a pass's cost curve is readable **while** it runs: the
     * recorded total says a round was expensive, and this says which of its batches was.
     */
    toolUses?: number;
    message?: string;
}

/**
 * Appends one heartbeat line.
 *
 * A write failure is swallowed on purpose: the log is an observation of the pass, and a pass must not die because its
 * observation could not be written. (The seal's heartbeat makes the same choice, in the same words.)
 */
export async function appendProgressLine(root: string, taskId: string, line: ProgressLine): Promise<boolean> {
    const path = adversarialProgressPath(root, taskId);
    try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(line)}\n`, 'utf8');
        return true;
    } catch {
        return false;
    }
}

/** Every line the pass has written, for the surfaces that report whether a pass is alive and where it is. */
export async function readProgressLines(root: string, taskId: string): Promise<ProgressLine[]> {
    try {
        const raw = await readFile(adversarialProgressPath(root, taskId), 'utf8');
        return raw
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .flatMap((line) => {
                try {
                    return [JSON.parse(line) as ProgressLine];
                } catch {
                    // A torn last line is what a crash looks like; it is reported as a line count, not as an error.
                    return [];
                }
            });
    } catch {
        return [];
    }
}

/** How many lines, and which was last — the answer to "is a pass running, and how far did it get". */
export async function progressSummary(root: string, taskId: string): Promise<{ lines: number; last: ProgressLine | null; lastAt: string | null }> {
    const lines = await readProgressLines(root, taskId);
    const last = lines.at(-1) ?? null;
    return { lines: lines.length, last, lastAt: last?.at ?? null };
}
