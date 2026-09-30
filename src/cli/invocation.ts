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

/**
 * The flags that take a value, so the positional guesser does not mistake a value for a change id.
 *
 * **This list was incomplete twice, and each time a flag's value took the change-id slot.** First `--review-evidence`
 * (`review --review-evidence hello --change t1` operated on a task named `hello`), then seven more an independent review
 * found: `--branch feature/x` read `feature/x` as the change id, and `--base main` became a branch named `kata/main`.
 *
 * **It is a hand-kept list that a test checks, not a derived table — and the comment used to claim otherwise.** Measured
 * twice: first three shapes were scanned and a flag read as `arg === '--x'` was invisible, then
 * `tests/unit/cli-flag-vocabulary.test.ts` was extended to that shape as well. What remains invisible is a flag reached
 * through a variable, a template-built flag name, or a reader outside `src/cli/`: the honest description is a strong
 * approximation with a named blind spot, caught by a case rather than by construction, so a reader that introduces a new
 * shape extends the scan.
 */
export const VALUE_FLAGS: readonly string[] = [
    '--add', '--actor', '--adapter', '--assurance', '--base', '--bootstrap-file', '--boundary', '--branch', '--by',
    '--candidate', '--change', '--choice', '--claim', '--command', '--covers', '--decision', '--depends-on',
    '--development', '--development-mode', '--diversity', '--endpoint', '--evidence', '--excludes', '--failure-count',
    '--failures', '--fails-on', '--field', '--file', '--findings-carried-to', '--for-task', '--from', '--home', '--id',
    '--instrument', '--isolation', '--isolation-mode', '--judgement', '--kind', '--language', '--mode', '--observed',
    '--out', '--owned-path', '--path', '--paths', '--per-claim', '--persist', '--platform', '--probe', '--producer',
    '--q', '--query', '--reason', '--record', '--remove', '--requirements-file', '--result-file', '--results-dir',
    '--review', '--review-evidence', '--review-mode', '--reviewed-path', '--risk-class', '--role', '--root',
    '--routing-mode', '--run-id', '--scope', '--seed', '--set-file', '--severity', '--since', '--statement', '--task',
    '--task-kind', '--tier', '--title', '--to', '--type', '--version', '--waivers-file', '--wiki', '--wiki-from',
];

export function parseRootArg(argv: string[]): string | undefined {
    const inline = inlineValue(argv, '--root');
    if (inline !== undefined) return inline;
    const index = argv.indexOf('--root');
    const value = index >= 0 ? argv[index + 1] : undefined;
    // **A flag's value is not the next flag.** Measured: `--root --change=c1` returned `"--change=c1"` as the root, so the
    // command ran against a workspace named after a flag. The spaced form takes the next token only when it is a value.
    return value === undefined || value.startsWith('--') ? undefined : value;
}

export function parseChangeArg(argv: string[]): string | undefined {
    const inline = inlineValue(argv, '--change');
    if (inline !== undefined) return inline;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--change') {
            const next = argv[index + 1];
            return next === undefined || next.startsWith('--') ? undefined : next;
        }
        if (VALUE_FLAGS.some((flag) => value === flag || value.startsWith(`${flag}=`))) {
            // A spaced form consumes the next token; an `=` form carries its own value and consumes nothing.
            if (!value.includes('=')) index += 1;
            continue;
        }
        if (value?.startsWith('--')) continue;
        // **The first bare token is the change id only when it is not already spoken for.** A subcommand such as the
        // `review` in `review --review-evidence hello --change t1` is positional, not the id: the flag vocabulary above
        // decides which tokens are values, and a bare token that precedes a `--change` is the command word.
        if (argv.slice(index + 1).some((entry) => entry === '--change' || entry.startsWith('--change='))) continue;
        return value;
    }
    return undefined;
}

/**
 * Split a hand-written literal-flag comparison into the flag and, when present, its inline value.
 *
 * **The `=` spelling has to resolve for hand-written parsers too, not only for the shared readers.** Measured by an
 * independent review: `relations add --from=task:a --to=task:b` was refused with `Unknown relations option: --from=task:a`,
 * and `install --platform=pi` likewise, because those loops compare whole tokens. Both spellings are the same flag on a
 * command line, so the comparison is done on the name and the inline value is returned alongside it.
 */
export function splitFlag(token: string): { flag: string; inline?: string } {
    if (!token.startsWith('--')) return { flag: token };
    const equals = token.indexOf('=');
    if (equals === -1) return { flag: token };
    return { flag: token.slice(0, equals), inline: token.slice(equals + 1) };
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
