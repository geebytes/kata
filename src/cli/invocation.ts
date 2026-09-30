/**
 * Shared invocation parsing.
 *
 * The command families extracted out of `cli.ts` each need to find the change id, the root and an option's value in raw
 * argv, so the readers live in one place rather than being copied per family. `parseChangeArg` is the transitional
 * positional guesser the architecture review calls out (L0-02): it keeps a list of flags that consume the next token, so
 * a new option means updating this list too. Each family that grows its own typed parser can stop using it.
 */

/**
 * **One rule for every flag reader, and this is where it lives.** §12.4 claimed `--flag=value` was resolved "once, for
 * every flag", but the rule went into `argValue` alone: `parseRootArg`/`parseChangeArg` and the repeated-value readers
 * still saw only the spaced form, so `kata-cli --root=/ws …` fell back to workspace discovery and quietly used the wrong
 * root — the fail-open direction of a spelling gap. Every reader below asks this one predicate.
 */
function inlineValue(argv: string[], flag: string): string | undefined {
    const inline = argv.find((entry) => entry.startsWith(`${flag}=`));
    if (inline === undefined) return undefined;
    const value = inline.slice(flag.length + 1);
    return value.trim() === '' ? undefined : value;
}

/** The tokens that consume the next argv entry, so the positional guesser does not mistake a value for a change id. */
const VALUE_FLAGS: readonly string[] = [
    '--platform', '--root', '--role', '--task-kind', '--mode', '--routing-mode', '--failures', '--failure-count',
    '--isolation', '--isolation-mode', '--development', '--development-mode', '--review', '--review-mode',
];

export function parseRootArg(argv: string[]): string | undefined {
    const inline = inlineValue(argv, '--root');
    if (inline !== undefined) return inline;
    const index = argv.indexOf('--root');
    return index >= 0 ? argv[index + 1] : undefined;
}

export function parseChangeArg(argv: string[]): string | undefined {
    const inline = inlineValue(argv, '--change');
    if (inline !== undefined) return inline;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--change') return argv[index + 1];
        if (VALUE_FLAGS.some((flag) => value === flag || value.startsWith(`${flag}=`))) {
            // A spaced form consumes the next token; an `=` form carries its own value and consumes nothing.
            if (!value.includes('=')) index += 1;
            continue;
        }
        if (value?.startsWith('--')) continue;
        return value;
    }
    return undefined;
}

/**
 * The value after a flag, or `undefined` when the next token is itself a flag.
 *
 * **The guard is the point, and there used to be three of these.** Three copies of this helper existed — `ops.ts`,
 * `scope.ts` and `workflow.ts` — and they disagreed: `scope.ts` refused a value that starts with `--`, the other two
 * returned it. So `open --title --isolation git_flow` set the task's title to `"--isolation"` on one path and was refused
 * on another, and which behaviour you got depended on which copy your command happened to use. Found while giving
 * `--title` its first reader.
 *
 * The rule the codebase already used in `parseChangeArg` is the one kept: **a token starting with `--` is a flag, not a
 * value.** The alternative — accepting any token — cannot tell `--title --isolation` from `--title --some-title`, and a
 * flag silently swallowing the next flag is how a required option goes missing.
 */
/**
 * The value a flag was given, in either spelling.
 *
 * `--flag value` and `--flag=value` are the same flag on a command line, and this reader used to see only the first, so
 * every caller inherited the gap: `ledger run --out=tmp/x.json` was recognised as "given" by one check and read as "not
 * given" by this one, producing a refusal that asked for the path it had just been handed. Both spellings resolve here,
 * once, for every flag — rather than per-flag in whichever module happened to notice.
 */
export function argValue(argv: string[], flag: string): string | undefined {
    const inline = argv.find((entry) => entry.startsWith(`${flag}=`));
    if (inline !== undefined) {
        const value = inline.slice(flag.length + 1);
        return value.trim() === '' ? undefined : value;
    }
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value !== undefined && !value.startsWith('--') ? value : undefined;
}
