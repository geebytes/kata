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

export function argValue(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}
