/**
 * Runs a falsifier's three steps and records what it observed — closure-gate AC-2's producer.
 *
 * A falsifier is *the check that must redden under the defect it names*, and by the time the repair is done the check passes.
 * A passing check proves nothing about its sensitivity, so showing it redden means putting the defect back:
 *
 *   1. run the check — it must **pass**, or the repair is not in place and this is a different error
 *   2. run the mutation, then the check again — it must **fail**, and that failure is the reddening
 *   3. run the restore, then the check once more — it must **pass**, which is what proves the tree came back
 *
 * **The check is the oracle for all three steps**, so no tree digest is needed and a restore that only looks right cannot
 * pass: if the check does not go green again, the restore did not work.
 *
 * The tool cannot invent step 2. Knowing how to re-introduce a defect is knowledge only the repairer has, so the mutation and
 * its restore are **declared** — and the tool's job is to run them and record what it saw, rather than accept a claim about
 * it. That is the same reason telemetry is measured rather than typed in.
 */
import { recordFalsifierReddening, type FalsifierReddening } from './falsifier-reddenings.js';

export type FalsifierRunResult =
    | { recorded: true; reddening: FalsifierReddening }
    | { recorded: false; refused: 'check_not_passing' | 'did_not_redden' | 'restore_failed'; detail: string };

/** Runs one command and reports its exit code. Injected so the three steps are testable without spawning anything. */
export type CommandRunner = (command: string) => Promise<number>;

export async function runFalsification(input: {
    root: string;
    taskId: string;
    findingId: string;
    /** The check that must redden — recorded as the falsifier. */
    check: string;
    /** How to re-introduce the defect. Declared by the repairer, because only it knows. */
    mutation: string;
    /** How to undo it. Declared for the same reason, and verified by the check rather than trusted. */
    restore: string;
    /** The revision this is being observed on. */
    revisionId: string;
    at: string;
    run: CommandRunner;
}): Promise<FalsifierRunResult> {
    const { root, taskId, findingId, check, mutation, restore, revisionId, at, run } = input;

    const first = await run(check);
    if (first !== 0) {
        return {
            recorded: false,
            refused: 'check_not_passing',
            detail: `The check exited ${first} before any mutation, so the repair is not in place and there is nothing to falsify.`,
        };
    }

    await run(mutation);
    const mutated = await run(check);
    if (mutated === 0) {
        return {
            recorded: false,
            refused: 'did_not_redden',
            detail: 'The check passed with the defect re-introduced, so it is not sensitive to this defect and proves nothing.',
        };
    }

    await run(restore);
    const restored = await run(check);
    if (restored !== 0) {
        return {
            recorded: false,
            refused: 'restore_failed',
            detail: `The check exited ${restored} after the restore, so the tree did not come back and the reddening above cannot be attributed to the mutation alone.`,
        };
    }

    const reddening: FalsifierReddening = {
        findingId,
        check,
        mutation,
        revisionId,
        reddenedAt: at,
        // What the producer observed, recorded rather than described: AC-4's rule is that a falsifier naming a check which was
        // never run does not close an obligation, and this is the fact that distinguishes the two.
        observed: { before: first, mutated, after: restored },
    };
    await recordFalsifierReddening(root, taskId, reddening);
    return { recorded: true, reddening };
}
