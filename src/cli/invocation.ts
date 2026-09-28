/**
 * Shared invocation parsing.
 *
 * The command families extracted out of `cli.ts` each need to find the change id, the root and an option's value in raw
 * argv, so the readers live in one place rather than being copied per family. `parseChangeArg` is the transitional
 * positional guesser the architecture review calls out (L0-02): it keeps a list of flags that consume the next token, so
 * a new option means updating this list too. Each family that grows its own typed parser can stop using it.
 */

export function parseRootArg(argv: string[]): string | undefined {
    const index = argv.indexOf('--root');
    return index >= 0 ? argv[index + 1] : undefined;
}

export function parseChangeArg(argv: string[]): string | undefined {
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--change') return argv[index + 1];
        if (
            value === '--platform'
            || value === '--root'
            || value === '--role'
            || value === '--task-kind'
            || value === '--mode'
            || value === '--routing-mode'
            || value === '--failures'
            || value === '--failure-count'
            || value === '--isolation'
            || value === '--isolation-mode'
            || value === '--development'
            || value === '--development-mode'
            || value === '--review'
            || value === '--review-mode'
        ) {
            index += 1;
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
export function argValue(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value !== undefined && !value.startsWith('--') ? value : undefined;
}
