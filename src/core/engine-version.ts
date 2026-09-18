import packageJson from 'kata-asset:package.json';

/**
 * The version of the engine that is running, and what a task was created or last advanced under (C7).
 *
 * §17.4: while passes were in flight, the review gate gained a node requirement and the brief gained a framing mode. Both
 * were improvements and both **cost a diagnostic cycle**, because the flow could not tell "the rules changed" from "I did
 * something wrong". §17.1 names the principle: a controlled process needs a versioned engine, and engine changes should
 * land between tasks rather than during one.
 *
 * What this deliberately is **not**: a compatibility gate. Kata is a tool that a project installs and updates at will, and
 * refusing to run because the version moved would break the exact situation it exists to explain. So the record *names* the
 * version, and a mismatch is **reported** — in the status surface and in a gate's diagnostics — never enforced.
 *
 * The field is *last seen*, not *first seen*: it is updated as a task advances, so it answers the question a reader
 * actually has when a gate behaves differently than it did yesterday — "did the engine change since I last ran this?" —
 * rather than the less useful "what version was this task created under".
 */
export interface EngineStamp {
    /** The `package.json` version of the running engine. */
    version: string;
    /** When the task record was last stamped, so "mid-task change" is answerable rather than inferred. */
    stampedAt: string;
}

/** The running engine's version, read from the package that this bundle was built from. */
export function engineVersion(): string {
    try {
        const parsed = JSON.parse(packageJson) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : 'unknown';
    } catch {
        // A malformed package.json is not a reason to fail a task: the version is a diagnostic, not a contract.
        return 'unknown';
    }
}

/** Whether a task's last-stamped version differs from the running one. */
export function engineVersionChanged(stamp: EngineStamp | undefined | null, running: string = engineVersion()): boolean {
    if (!stamp?.version) return false;
    return stamp.version !== running;
}

/**
 * What to say about a mismatch, or `null` when there is nothing to say.
 *
 * The sentence is deliberately one of three: a change *is* the explanation a reader needs when a gate suddenly asks for
 * something it never asked for before, and stating it costs one line where the absence of it cost a diagnostic cycle.
 */
export function engineChangeNote(stamp: EngineStamp | undefined | null, running: string = engineVersion()): string | null {
    if (!engineVersionChanged(stamp, running)) return null;
    return `This task last ran under kata ${stamp?.version} and is now running under ${running}.`
        + ' A gate may ask for something it did not ask for before: that is an engine change, not a mistake in your run.';
}
